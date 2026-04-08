// turbo_client.js - Bookish upload client via Tarn API
// Creates client-signed ANS-104 data items and sends them through the Tarn API.
// The API handles fee validation, Turbo forwarding, write-through cache, and pending tx tracking.

import { createSignedDataItem } from './core/ans104_signer.js';
import { append as logAppend } from './core/log_local.js';
import { ensureAuth } from './core/tarn_auth.js';

const TARN_API = window.BOOKISH_API_BASE || 'https://api.tarn.dev';
const BASE_RPC = window.BOOKISH_BASE_RPC || 'https://mainnet.base.org';

let _feeSchedule = null;
let _pendingNonce = null;

async function getFeeSchedule(forceRefresh = false) {
  if (_feeSchedule && !forceRefresh) return _feeSchedule;
  try {
    const r = await fetch(`${TARN_API}/api/v1/fees`);
    if (r.ok) _feeSchedule = await r.json();
  } catch { /* use cached or null */ }
  return _feeSchedule;
}

function reset() {
  _feeSchedule = null;
  _pendingNonce = null;
}

async function estimateCost(byteLength) {
  try {
    const schedule = await getFeeSchedule();
    return BigInt(schedule?.fee || '0');
  } catch {
    return 0n;
  }
}

// ============ ETH Fee Transaction Signing (lazy-loads ethers only for paid uploads) ============

async function signFeeTx(feeSchedule) {
  const { Wallet, JsonRpcProvider, parseUnits } = await import('https://esm.sh/ethers@6.13.0');
  const pk = await window.bookishWallet.getPrivateKey();
  const provider = new JsonRpcProvider(BASE_RPC, 8453, { staticNetwork: true });
  const wallet = new Wallet(pk, provider);

  const feeWei = BigInt(feeSchedule.fee);
  const chainNonce = await provider.getTransactionCount(wallet.address, 'pending');
  const nonce = (_pendingNonce !== null && _pendingNonce >= chainNonce)
    ? _pendingNonce
    : chainNonce;
  _pendingNonce = nonce + 1;

  const tx = await wallet.signTransaction({
    to: feeSchedule.address,
    value: feeWei,
    chainId: 8453,
    type: 2,
    nonce,
    maxFeePerGas: parseUnits('0.15', 'gwei'),
    maxPriorityFeePerGas: parseUnits('0.001', 'gwei'),
    gasLimit: 21000n,
  });

  return { signedTx: tx };
}

// ============ Route selection ============

function determineEndpoint(tags) {
  const isTombstone = tags.some(t => t.name === 'Op' && t.value === 'tombstone');
  const refTag = tags.find(t => t.name === 'Ref')?.value;
  if (isTombstone && refTag) return { method: 'DELETE', path: `/api/v1/entries/${refTag}` };

  const prevTag = tags.find(t => t.name === 'Prev')?.value;
  if (prevTag) return { method: 'PUT', path: `/api/v1/entries/${prevTag}` };

  return { method: 'POST', path: '/api/v1/entries' };
}

// ============ Upload ============

async function upload(dataBytes, tags, { skipFee = false } = {}) {
  let dtTags = Array.isArray(tags) ? [...tags] : [];
  const hasCT = dtTags.some(t => (t.name || '').toLowerCase() === 'content-type');
  if (!hasCT) dtTags.unshift({ name: 'Content-Type', value: 'application/octet-stream' });

  const payloadBytes = dataBytes instanceof Uint8Array ? dataBytes.length : (dataBytes?.byteLength || 0);
  const { method, path } = determineEndpoint(dtTags);
  console.info('[Bookish:Upload] uploading via Tarn API', { bytes: payloadBytes, tags: dtTags.length, skipFee, method, path });
  logAppend('upload', 'tarn-start', { bytes: payloadBytes, skipFee, method });

  const pk = await window.bookishWallet.getPrivateKey();
  const signedBytes = await createSignedDataItem(pk, dataBytes, dtTags);

  // Fee handling — only for creates (POST) that aren't fee-exempt
  let payment = null;
  if (!skipFee && method === 'POST') {
    let feeSchedule = await getFeeSchedule();
    if (!feeSchedule) throw new Error('Unable to fetch fee schedule from Tarn API');
    payment = await signFeeTx(feeSchedule);
  }

  // Authenticate with Tarn API
  const jwt = await ensureAuth();

  let response = await doUpload(signedBytes, dtTags, payment, jwt, method, path);

  if (!skipFee && method === 'POST' && response.status === 402) {
    console.warn('[Bookish:Upload] 402 received, re-fetching fee schedule and retrying');
    if (_pendingNonce !== null) _pendingNonce--;
    const feeSchedule = await getFeeSchedule(true);
    if (feeSchedule) {
      payment = await signFeeTx(feeSchedule);
      response = await doUpload(signedBytes, dtTags, payment, jwt, method, path);
    }
  }

  if (!response.ok) {
    if (response.status === 402) _pendingNonce = null;
    const errBody = await response.json().catch(() => ({}));
    const err = new Error(errBody.error || `Tarn API returned ${response.status}`);
    err.code = errBody.code || `tarn-${response.status}`;
    err.status = response.status;
    throw err;
  }

  const result = await response.json();
  const id = result.id;
  if (!id) throw new Error('missing-id');

  if (!skipFee && method === 'POST' && !result.feeTxHash) {
    _pendingNonce = null;
    console.warn('[Bookish:Upload] Fee broadcast may have failed (feeTxHash missing)', { feeError: result.feeError });
  }

  console.info('[Bookish:Upload] upload success', { id, feeTxHash: result.feeTxHash });
  logAppend('upload', 'tarn-success', { id, feeTxHash: result.feeTxHash, feeError: result.feeError || null });
  return { id };
}

async function doUpload(signedBytes, tags, payment, jwt, method, path) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Arweave-Tags': JSON.stringify(tags),
    'X-Signed-DataItem': 'true',
    'Authorization': `Bearer ${jwt}`,
  };
  if (payment) headers['X-Payment'] = JSON.stringify(payment);

  return fetch(`${TARN_API}${path}`, {
    method,
    headers,
    body: signedBytes,
  });
}

window.bookishUpload = { upload, estimateCost, reset };
