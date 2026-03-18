// ans104_signer.js - Lightweight ANS-104 Ethereum data item signer
// Replaces arbundles (~300KB+ with ethers) with ~20KB of focused deps.
// Uses @noble/curves for secp256k1, @noble/hashes for keccak256, WebCrypto for SHA-384.

import { secp256k1 } from 'https://esm.sh/@noble/curves@1.6.0/secp256k1';
import { keccak_256 } from 'https://esm.sh/@noble/hashes@1.5.0/sha3';

const SIG_TYPE = 3;     // Ethereum
const SIG_LEN = 65;     // r(32) + s(32) + v(1)
const OWNER_LEN = 65;   // uncompressed secp256k1 public key (04 || x || y)
const enc = new TextEncoder();

// ---- Helpers ----

function hexToBytes(hex) {
  if (hex.startsWith('0x')) hex = hex.slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function concat(...arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ---- Avro tag serialization (ANS-104 spec) ----
// Tags are an Avro array of {name: bytes, value: bytes} records.

function avroLong(n) {
  let z = (n << 1) ^ (n >> 31);
  const buf = [];
  while ((z & ~0x7f) !== 0) { buf.push((z & 0x7f) | 0x80); z >>>= 7; }
  buf.push(z & 0x7f);
  return new Uint8Array(buf);
}

function serializeTags(tags) {
  if (!tags || tags.length === 0) return new Uint8Array(0);
  const parts = [avroLong(tags.length)];
  for (const { name, value } of tags) {
    const nb = enc.encode(name), vb = enc.encode(value);
    parts.push(avroLong(nb.length), nb, avroLong(vb.length), vb);
  }
  parts.push(new Uint8Array([0]));
  return concat(...parts);
}

// ---- Deep hash (SHA-384 via WebCrypto, per ANS-104 spec) ----

async function sha384(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-384', data));
}

async function deepHash(data) {
  if (data instanceof Uint8Array) {
    const tag = await sha384(concat(enc.encode('blob'), enc.encode(String(data.byteLength))));
    return sha384(concat(tag, await sha384(data)));
  }
  let acc = await sha384(concat(enc.encode('list'), enc.encode(String(data.length))));
  for (const chunk of data) acc = await sha384(concat(acc, await deepHash(chunk)));
  return acc;
}

// ---- EIP-191 personal_sign hash ----
// Matches ethers Wallet.signMessage() / arbundles EthereumSigner.sign():
//   keccak256("\x19Ethereum Signed Message:\n" + len + message)

function eip191Hash(message) {
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${message.length}`);
  return keccak_256(concat(prefix, message));
}

// ---- Public API ----

/**
 * Create a signed ANS-104 data item (Ethereum, signature type 3).
 * Compatible with Turbo's /v1/tx signed data item endpoint.
 *
 * @param {string} privateKeyHex  Hex private key (with or without 0x)
 * @param {Uint8Array} data       Payload bytes
 * @param {Array<{name:string, value:string}>} tags  Arweave tags
 * @returns {Promise<Uint8Array>} Raw signed data item bytes ready for upload
 */
export async function createSignedDataItem(privateKeyHex, data, tags) {
  const pk = hexToBytes(privateKeyHex);
  const owner = secp256k1.getPublicKey(pk, false);
  const tagBytes = serializeTags(tags);
  const payload = data instanceof Uint8Array ? data : new Uint8Array(data);

  const signData = await deepHash([
    enc.encode('dataitem'), enc.encode('1'), enc.encode(String(SIG_TYPE)),
    owner,
    new Uint8Array(0),  // target (none)
    new Uint8Array(0),  // anchor (none)
    tagBytes,
    payload,
  ]);

  const digest = eip191Hash(signData);
  const sig = secp256k1.sign(digest, pk);
  const signature = concat(sig.toCompactRawBytes(), new Uint8Array([sig.recovery + 27]));

  // Binary layout: sigType(2 LE) | sig(65) | owner(65) | target?(1) | anchor?(1) | nTags(8 LE) | tagLen(8 LE) | tags | data
  const numTags = tags ? tags.length : 0;
  const hdrLen = 2 + SIG_LEN + OWNER_LEN + 1 + 1 + 8 + 8;
  const hdr = new ArrayBuffer(hdrLen);
  const v = new DataView(hdr);
  let p = 0;
  v.setUint16(p, SIG_TYPE, true);                                     p += 2;
  new Uint8Array(hdr, p, SIG_LEN).set(signature);                     p += SIG_LEN;
  new Uint8Array(hdr, p, OWNER_LEN).set(owner);                       p += OWNER_LEN;
  v.setUint8(p, 0);                                                   p += 1;
  v.setUint8(p, 0);                                                   p += 1;
  v.setUint32(p, numTags, true); v.setUint32(p + 4, 0, true);        p += 8;
  v.setUint32(p, tagBytes.length, true); v.setUint32(p + 4, 0, true);

  return concat(new Uint8Array(hdr), tagBytes, payload);
}
