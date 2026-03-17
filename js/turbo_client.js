// turbo_client.js - Bookish upload client via Upload Proxy (Cloudflare Worker)
// Signs an ERC-3009 USDC payment authorization and sends it with encrypted data.

import { Wallet, Signature } from 'https://esm.sh/ethers@6.13.0';
import { append as logAppend } from './core/log_local.js';

const UPLOAD_PROXY = window.BOOKISH_UPLOAD_PROXY || 'https://bookish-upload-proxy.bookish.workers.dev';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

let _feeSchedule = null;

async function getFeeSchedule(forceRefresh = false) {
  if (_feeSchedule && !forceRefresh) return _feeSchedule;
  try {
    const r = await fetch(`${UPLOAD_PROXY}/info`);
    if (r.ok) _feeSchedule = await r.json();
  } catch { /* use cached or null */ }
  return _feeSchedule;
}

function reset() {
  _feeSchedule = null;
}

async function estimateCost(byteLength) {
  try {
    const schedule = await getFeeSchedule();
    return BigInt(schedule?.fee || '0');
  } catch {
    return 0n;
  }
}

// ============ ERC-3009 Signing ============

async function signERC3009Authorization(feeSchedule) {
  const pk = await window.bookishWallet.getPrivateKey();
  const wallet = new Wallet(pk);

  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: USDC_CONTRACT,
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const value = {
    from: wallet.address,
    to: feeSchedule.address,
    value: feeSchedule.fee,
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 300, // 5 min expiry
    nonce,
  };

  const signature = await wallet.signTypedData(domain, types, value);
  const { v, r, s } = Signature.from(signature);

  return { ...value, v, r, s };
}

// ============ Upload ============

async function upload(dataBytes, tags, { skipFee = false } = {}) {
  let dtTags = Array.isArray(tags) ? [...tags] : [];
  const hasCT = dtTags.some(t => (t.name || '').toLowerCase() === 'content-type');
  if (!hasCT) dtTags.unshift({ name: 'Content-Type', value: 'application/octet-stream' });

  const payloadBytes = dataBytes instanceof Uint8Array ? dataBytes.length : (dataBytes?.byteLength || 0);
  console.info('[Bookish:Upload] uploading via proxy', { bytes: payloadBytes, tags: dtTags.length, skipFee });
  logAppend('upload', 'proxy-start', { bytes: payloadBytes, skipFee });

  let payment = null;
  if (!skipFee) {
    let feeSchedule = await getFeeSchedule();
    if (!feeSchedule) throw new Error('Unable to fetch fee schedule from upload proxy');
    payment = await signERC3009Authorization(feeSchedule);
  }

  let response = await doUpload(dataBytes, dtTags, payment);

  if (!skipFee && response.status === 402) {
    console.warn('[Bookish:Upload] 402 received, re-fetching fee schedule and retrying');
    const feeSchedule = await getFeeSchedule(true);
    if (feeSchedule) {
      payment = await signERC3009Authorization(feeSchedule);
      response = await doUpload(dataBytes, dtTags, payment);
    }
  }

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const err = new Error(errBody.error || `Upload proxy returned ${response.status}`);
    err.code = errBody.code || `proxy-${response.status}`;
    err.status = response.status;
    throw err;
  }

  const result = await response.json();
  const id = result.id;
  if (!id) throw new Error('missing-id');

  console.info('[Bookish:Upload] upload success', { id, feeTxHash: result.feeTxHash });
  logAppend('upload', 'proxy-success', { id, feeTxHash: result.feeTxHash });
  return { id };
}

async function doUpload(dataBytes, tags, payment) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Arweave-Tags': JSON.stringify(tags),
  };
  if (payment) headers['X-Payment'] = JSON.stringify(payment);

  return fetch(`${UPLOAD_PROXY}/upload`, {
    method: 'POST',
    headers,
    body: dataBytes,
  });
}

window.bookishUpload = { upload, estimateCost, reset };
