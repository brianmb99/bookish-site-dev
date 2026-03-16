// turbo_client.js - Bookish upload client using ArDrive Turbo SDK (Base-ETH)
// Uploads via Turbo, which bundles data items and posts them to Arweave L1.

import { TurboFactory } from 'https://esm.sh/@ardrive/turbo-sdk/web';
import { Wallet, JsonRpcProvider } from 'https://esm.sh/ethers@6.13.0';
import { append as logAppend } from './core/log_local.js';

const BASE_RPC = window.BOOKISH_BASE_RPC || 'https://mainnet.base.org';

let _turbo = null;

async function getPrivateKey() {
  try {
    return await window.bookishWallet.getPrivateKey();
  } catch (e) {
    if ((e && (e.code === 'wallet-missing' || String(e.message).includes('wallet-missing'))) && window.bookishWallet?.ensure) {
      const ok = await window.bookishWallet.ensure();
      if (ok) return await window.bookishWallet.getPrivateKey();
    }
    const err = new Error('wallet-missing'); err.code = 'wallet-missing'; throw err;
  }
}

async function getTurbo() {
  if (_turbo) return _turbo;
  const pk = await getPrivateKey();
  _turbo = TurboFactory.authenticated({ privateKey: pk, token: 'base-eth' });
  return _turbo;
}

async function getSigner() {
  const pk = await getPrivateKey();
  const provider = new JsonRpcProvider(BASE_RPC);
  return new Wallet(pk, provider);
}

function reset() {
  _turbo = null;
}

async function estimateCost(byteLength) {
  try {
    const turbo = await getTurbo();
    const [costs] = await turbo.getUploadCosts({ bytes: [byteLength] });
    return BigInt(costs?.winc || '0');
  } catch {
    return 0n;
  }
}

async function upload(dataBytes, tags) {
  // --- Flat protocol fee (per-upload) ---
  // Sent BEFORE the upload. Fee failure never blocks the upload.
  try {
    const { PROTOCOL_CONFIG } = await import('./core/protocol_config.js');
    if (PROTOCOL_CONFIG.FEE_ENABLED && PROTOCOL_CONFIG.FLAT_FEE_WEI) {
      const { sendProtocolFee, logFeeEvent } = await import('./core/protocol_fee.js');
      const flatFee = BigInt(PROTOCOL_CONFIG.FLAT_FEE_WEI);
      logFeeEvent({ type: 'flat-fee-start', feeWei: flatFee.toString() });
      console.info('[Bookish:Turbo] sending protocol fee…', { feeWei: flatFee.toString() });

      const feeSigner = await getSigner();
      try {
        const feeResult = await Promise.race([
          sendProtocolFee(flatFee, feeSigner),
          new Promise(resolve => setTimeout(() => resolve(null), 15000)),
        ]);
        if (feeResult?.txHash) {
          logFeeEvent({ type: 'flat-fee-sent', txHash: feeResult.txHash });
          console.info('[Bookish:Turbo] protocol fee sent', { txHash: feeResult.txHash });
        } else {
          logFeeEvent({ type: 'flat-fee-skipped' });
          console.info('[Bookish:Turbo] protocol fee skipped (send failed or timed out)');
        }
      } catch {
        logFeeEvent({ type: 'flat-fee-error' });
      }
    }
  } catch (feeErr) {
    console.warn('[Bookish:ProtocolFee] Fee module error (non-blocking):', feeErr?.message || feeErr);
  }

  // --- Upload via Turbo ---
  const turbo = await getTurbo();

  let dtTags = Array.isArray(tags) ? [...tags] : [];
  const hasCT = dtTags.some(t => (t.name || '').toLowerCase() === 'content-type');
  if (!hasCT) dtTags.unshift({ name: 'Content-Type', value: 'application/octet-stream' });

  const payloadBytes = dataBytes instanceof Uint8Array ? dataBytes.length : (dataBytes?.byteLength || 0);
  console.info('[Bookish:Turbo] uploading', { bytes: payloadBytes, tags: dtTags.length });
  logAppend('upload', 'turbo-start', { bytes: payloadBytes });

  try {
    const result = await turbo.uploadFile({
      fileStreamFactory: () => new Response(dataBytes).body,
      fileSizeFactory: () => payloadBytes,
      dataItemOpts: { tags: dtTags },
    });

    const id = result.id || result.dataItemId;
    if (!id) throw new Error('missing-id');

    console.info('[Bookish:Turbo] upload success', { id });
    logAppend('upload', 'turbo-success', { id });
    return { id };
  } catch (err) {
    console.error('[Bookish:Turbo] upload failed', err);
    logAppend('upload', 'turbo-error', { code: err?.code, msg: err?.message });
    throw err;
  }
}

window.bookishUpload = { upload, estimateCost, reset };
