// turbo_client.js - Bookish upload client via Upload Proxy (Cloudflare Worker)
// Signs a native ETH fee transaction and sends it (serialized) with encrypted data.

import { Wallet, JsonRpcProvider, parseUnits } from 'https://esm.sh/ethers@6.13.0';
import { append as logAppend } from './core/log_local.js';

const UPLOAD_PROXY = window.BOOKISH_UPLOAD_PROXY || 'https://bookish-upload-proxy.bookish.workers.dev';
const BASE_RPC = window.BOOKISH_BASE_RPC || 'https://base.llamarpc.com';

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

// ============ ETH Fee Transaction Signing ============

async function signFeeTx(feeSchedule) {
  const pk = await window.bookishWallet.getPrivateKey();
  const provider = new JsonRpcProvider(BASE_RPC, 8453, { staticNetwork: true });
  const wallet = new Wallet(pk, provider);

  const feeWei = BigInt(feeSchedule.fee);
  const nonce = await provider.getTransactionCount(wallet.address, 'latest');

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
    payment = await signFeeTx(feeSchedule);
  }

  let response = await doUpload(dataBytes, dtTags, payment);

  if (!skipFee && response.status === 402) {
    console.warn('[Bookish:Upload] 402 received, re-fetching fee schedule and retrying');
    const feeSchedule = await getFeeSchedule(true);
    if (feeSchedule) {
      payment = await signFeeTx(feeSchedule);
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
