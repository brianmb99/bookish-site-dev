// irys_client_browser.js - Minimal browser Irys client for Base-ETH using ethers v6 signer
// This avoids bundling the full SDK by using fetch to Irys REST endpoints where possible.

import { Wallet, JsonRpcProvider } from 'https://esm.sh/ethers@6';
import { resolveToken, detectToken, getNodeInfo as httpGetNodeInfo, estimateCost as httpEstimateCost, getFundingAddress as httpGetFundingAddress, getNodeUrl as httpGetNodeUrl } from './irys_http.js';
import { append as logAppend } from './core/log_local.js';
import { decideFunding } from './core/funding_policy.js';

function getIrysNode(){ return httpGetNodeUrl(); }
// Token handling: prefer user override; otherwise detect from /info
function getToken(){ return (window.__bookishResolvedToken || 'base'); }
const BASE_RPC = window.BOOKISH_BASE_RPC || 'https://mainnet.base.org';

// Funding/retry policy
const FUND_BUFFER_BPS = 1000; // 10%
const RETRY_AFTER_FUND_MS = 180000; // 3 minutes default retry window after sending on-chain funds
const RETRY_WITH_RECENT_FUND_MS = 480000; // 8 minutes when a recent fund exists (give node more time to credit)
const RETRY_INTERVAL_MS = 7000; // poll interval for commit retries
const FUND_COOLDOWN_MS = 8 * 60 * 1000; // don't re-fund within 8 minutes for the same node/token/address
const INSUFF_FUNDS_COOLDOWN_MS = 3 * 60 * 1000; // after insufficient base funds, block auto-fund for 3 minutes

const LS_LAST_FUND_KEY = 'bookish:irys:lastFund';
const LS_FUND_BLOCK_KEY = 'bookish:irys:fundBlock';

function lsReadJSON(key){ try{ const t = localStorage.getItem(key); return t ? JSON.parse(t) : null; }catch{ return null; } }
function lsWriteJSON(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch{} }
function now(){ return Date.now(); }
function recordLastFund({ node, token, address, amountWei, txHash }){
  lsWriteJSON(LS_LAST_FUND_KEY, { node, token, address, amountWei: String(amountWei), txHash, at: now() });
}
function getLastFund(){ return lsReadJSON(LS_LAST_FUND_KEY); }
function setFundBlock({ address, reason }){ lsWriteJSON(LS_FUND_BLOCK_KEY, { address, reason, until: now() + INSUFF_FUNDS_COOLDOWN_MS }); }
function getFundBlock(){ const b = lsReadJSON(LS_FUND_BLOCK_KEY); if(!b) return null; if((b.until||0) < now()) return null; return b; }

async function getSigner(){
  try{
    const pk = await window.bookishWallet.getPrivateKey();
    const provider = new JsonRpcProvider(BASE_RPC);
    return new Wallet(pk, provider);
  } catch(e){
    // Attempt to auto-ensure wallet if missing, then retry once
    if((e && (e.code==='wallet-missing' || String(e.message).includes('wallet-missing'))) && window.bookishWallet?.ensure){
      if(window.BOOKISH_DEBUG) console.debug('[Bookish] getSigner: ensuring wallet…');
      const ok = await window.bookishWallet.ensure();
      if(ok){
        const pk = await window.bookishWallet.getPrivateKey();
        const provider = new JsonRpcProvider(BASE_RPC);
        return new Wallet(pk, provider);
      }
    }
    const err = new Error('wallet-missing'); err.code='wallet-missing'; throw err;
  }
}

async function fetchJSON(url, init){
  const r = await fetch(url, init);
  const text = await r.text();
  let json=null; try{ json = text? JSON.parse(text):null; }catch{}
  return { ok:r.ok, status:r.status, json, text };
}

// Safe base64 encoder for Uint8Array (chunked to avoid stack overflows)
function bytesToBase64Chunked(bytes){
  let binary=''; const chunk=0x4000; // 16 KiB
  for(let i=0;i<bytes.length;i+=chunk){
    const sub = bytes.subarray(i, Math.min(i+chunk, bytes.length));
    let part='';
    for(let j=0;j<sub.length;j++) part += String.fromCharCode(sub[j]);
    binary += part;
  }
  return btoa(binary);
}

async function getNodeInfo(){ return await httpGetNodeInfo(); }

// Get price for a byte size from Irys (single token, fast-fail)
async function estimateCost(byteLength){ return await httpEstimateCost(byteLength); }

// Balance is not queried in this flow (nodes may hide it). Kept as no-op placeholder if needed later.
async function getIrysBalance(){ return { balance: null, prepaid: null, unknown: true }; }

// Fund Irys account by sending a transaction via the signer
async function fund(amountWei){ return await fundOnChain(amountWei); }

// Resolve funding address from /info, overrides, and token variants
async function getFundingAddress(){
  return await httpGetFundingAddress();
}

// Explicit on-chain transfer helper (bypasses REST funding endpoint entirely)
async function fundOnChain(amountWei){
  const signer = await getSigner();
  const fundAddr = await getFundingAddress();
  if(!fundAddr){ const e=new Error('no-funding-address'); e.code='no-funding-address'; throw e; }
  try{
    const from = await signer.getAddress();
    const dbgToken = await resolveToken();
    const nodeUrl = getIrysNode();
    console.info('[Bookish:Irys] funding:onchain start', { nodeUrl, token: dbgToken, from, to: fundAddr, amountWei: String(amountWei) });
    const tx = await signer.sendTransaction({ to: fundAddr, value: BigInt(amountWei) });
    console.info('[Bookish:Irys] funding:onchain sent', { hash: tx.hash });
    await (tx.wait?.(1).catch(()=>{}));
    console.info('[Bookish:Irys] funding:onchain confirmed-ish');
    return { txId: tx.hash, onChain: true };
  }catch(err){
    console.warn('[Bookish:Irys] funding:onchain error', err);
    throw err;
  }
}

// Upload data with tags: requires signing a Bundlr/Irys manifest; this minimal client sends raw data
// to the /bundle/tx endpoint. Some nodes require a full signed data item; for vNext we assume node supports it.
async function upload(dataBytes, tags){
  const signer = await getSigner();
  const address = await signer.getAddress();
  // New flow: attempt upload; on 402, fund price*buffer once, then retry commit for up to 120s.
  // Always use signed DataItem upload using @irys/bundles (browser-safe ESM)
  async function uploadSignedViaBundles(bytes, tags){
    // Import only the minimal browser-safe modules to avoid Node fs/tmp deps
  const signerMod = await import('https://esm.sh/@irys/bundles@0.0.3/build/web/esm/src/signing/chains/ethereumSigner.js');
  const createMod = await import('https://esm.sh/@irys/bundles@0.0.3/build/web/esm/src/ar-data-create.js');
  const bundleMod = await import('https://esm.sh/@irys/bundles@0.0.3/build/web/esm/src/ar-data-bundle.js');
  const dataItemMod = await import('https://esm.sh/@irys/bundles@0.0.3/build/web/esm/src/DataItem.js');
  const EthereumSigner = signerMod.default || signerMod.EthereumSigner;
  const createData = createMod.createData;
    if(!EthereumSigner){ const e=new Error('missing-ethereum-signer'); e.code='upload-config'; throw e; }
    if(!createData){ const e=new Error('missing-createData'); e.code='upload-config'; throw e; }

  const pk = await window.bookishWallet.getPrivateKey();
  const pkHex = pk && pk.startsWith('0x') ? pk.slice(2) : pk;
  const ethSigner = new EthereumSigner(pkHex);

    // Prepare DataItem
    // Patch DataItem.sign to avoid Node crypto rawId getter usage
    const DataItemCls = dataItemMod.default || dataItemMod.DataItem;
    if (DataItemCls && !DataItemCls.__bookishPatched) {
      DataItemCls.prototype.sign = async function(s) {
        const { signature, id } = await bundleMod.getSignatureAndId(this, s);
        this.getRaw().set(signature, 2);
        this._id = id;
        return id;
      };
      DataItemCls.__bookishPatched = true;
    }
  // Ensure Content-Type tag present
  let dtTags = Array.isArray(tags) ? [...tags] : [];
  const hasCT = dtTags.some(t => (t.name||'').toLowerCase() === 'content-type');
  if(!hasCT){ dtTags.unshift({ name: 'Content-Type', value: 'application/octet-stream' }); }
    // Debug context
    try{
      const dbgSigner = await getSigner();
      const dbgAddr = await dbgSigner.getAddress();
      const dbgNode = getIrysNode();
      const dbgToken = await resolveToken();
      const dbgFundAddr = await getFundingAddress().catch(()=>null);
      const dbgBaseBal = await dbgSigner.provider.getBalance(dbgAddr).catch(()=>null);
      console.info('[Bookish:Irys] preflight', {
        node: dbgNode,
        token: dbgToken,
        walletAddress: dbgAddr,
        fundingAddress: dbgFundAddr,
        payloadBytes: bytes?.length ?? (bytes?.byteLength ?? null),
        baseBalanceWei: dbgBaseBal?.toString?.()
      });
    }catch(err){ console.info('[Bookish:Irys] preflight-log-failed', err); }

    // Preflight: log price (balance may be unknown)
    try{
      const price = await estimateCost(bytes.length).catch(()=>null);
      const addr = await (await getSigner()).getAddress();
      if(price){ console.info('[Bookish:Irys] price', { priceWei: price.toString(), addr }); }
    }catch(preErr){ console.info('[Bookish:Irys] preflight-note', preErr?.code || preErr?.message || preErr); /* continue; node will enforce */ }

    // --- Flat protocol fee (per-upload) ---
    // Sent BEFORE the upload so it works regardless of whether Irys charges (402)
    // or subsidises the upload. Fee failure never blocks the upload.
    try {
      const { PROTOCOL_CONFIG } = await import('./core/protocol_config.js');
      if (PROTOCOL_CONFIG.FEE_ENABLED && PROTOCOL_CONFIG.FLAT_FEE_WEI) {
        const { sendProtocolFee, logFeeEvent } = await import('./core/protocol_fee.js');
        const flatFee = BigInt(PROTOCOL_CONFIG.FLAT_FEE_WEI);
        logFeeEvent({ type: 'flat-fee-start', feeWei: flatFee.toString() });
        console.info('[Bookish:Irys] sending protocol fee…', { feeWei: flatFee.toString() });

        const feeSigner = await getSigner();
        try {
          const feeResult = await Promise.race([
            sendProtocolFee(flatFee, feeSigner),
            new Promise(resolve => setTimeout(() => resolve(null), 15000)),
          ]);
          if (feeResult?.txHash) {
            logFeeEvent({ type: 'flat-fee-sent', txHash: feeResult.txHash });
            console.info('[Bookish:Irys] protocol fee sent', { txHash: feeResult.txHash });
          } else {
            logFeeEvent({ type: 'flat-fee-skipped' });
            console.info('[Bookish:Irys] protocol fee skipped (send failed or timed out)');
          }
        } catch {
          logFeeEvent({ type: 'flat-fee-error' });
        }
      }
    } catch (feeErr) {
      console.warn('[Bookish:ProtocolFee] Fee module error (non-blocking):', feeErr?.message || feeErr);
    }

    const dataItem = createData(bytes, ethSigner, { tags: dtTags });
    // Use web-safe signer to sign, which we also patched onto DataItem
    await bundleMod.sign(dataItem, ethSigner);
    const raw = (typeof dataItem.getRaw === 'function') ? dataItem.getRaw() : dataItem.raw || dataItem;

    const tk = await resolveToken();
    const tryPost = async ()=>{
      const resp = await fetch(`${getIrysNode()}/tx/${tk}`, {
      method:'POST', headers:{ 'Content-Type':'application/octet-stream' }, body: raw
      });
      const text = await resp.text();
      let json=null; try{ json=text?JSON.parse(text):null; }catch{}
      return { resp, text, json };
    };

    async function retryCommit(maxMs){
      const start = now(); let attempt=0;
      logAppend('funding', 'retry-start', { maxMs });
      console.info('[Bookish:Irys] retrying commit…', { maxMs, intervalMs: RETRY_INTERVAL_MS });
      for(;;){
        await new Promise(r=>setTimeout(r, RETRY_INTERVAL_MS));
        attempt++;
        let resp, text, json;
        try{ ({ resp, text, json } = await tryPost()); }catch(postErr){ console.info('[Bookish:Irys] retry network error', postErr); continue; }
        console.info('[Bookish:Irys] retry attempt', { attempt, status: resp.status });
        if(resp.ok){
          const id = json?.id || json?.dataId || json?.txId || json?.transactionId;
          if(!id) throw new Error('missing-id');
          logAppend('funding', 'retry-success', { attempt, id });
          return { id };
        }
        if(resp.status!==402){
          console.info('[Bookish:Irys] non-402 during retry', { status: resp.status, body: json||text });
          const e=new Error(`upload-http-${resp.status}`); e.details=json||text; throw e;
        }
        if(now() - start > maxMs){
          console.info('[Bookish:Irys] post-fund retry window exhausted – still 402', json||text);
          logAppend('funding', 'retry-timeout', { maxMs, attempts: attempt, details: json||text });
          const e=new Error('post-fund-timeout'); e.code='post-fund-timeout'; e.details=json||text; throw e;
        }
      }
    }

    // First attempt
    let { resp, text, json } = await tryPost();
    if(resp.status===402){
      logAppend('funding', '402-received', { status: resp.status });
      console.info('[Bookish:Irys] upload 402 – initiating single on-chain funding then retry window');
      // Use actual DataItem size for price estimation (includes headers/tags/signature)
      const chargeBytes = (raw && (raw.byteLength||raw.length)) ? (raw.byteLength||raw.length) : (bytes?.length||0);
  // Estimate price
      const price = await estimateCost(chargeBytes).catch(()=>null);
      if(!price){ const e=new Error('price-failed'); e.code='price-failed'; throw e; }

      // Compute gas reserve for precheck
      const signerForFunds = await getSigner();
      const identity = { node: getIrysNode(), token: tk, address: await signerForFunds.getAddress() };
      const walletBal = await signerForFunds.provider.getBalance(identity.address).catch(()=>null);
      let gasReserve = 0n;
      try{
        const fee = await signerForFunds.provider.getFeeData();
        const perGas = BigInt((fee.maxFeePerGas ?? fee.gasPrice ?? 1n));
        const gasLimit = 21000n; // simple transfer
        gasReserve = (gasLimit * perGas * 12n) / 10n; // 1.2x cushion
      }catch{}

      // Use funding policy to decide action
      const lf = getLastFund();
      const fundBlock = getFundBlock();
      const decision = decideFunding({
        priceWei: price.toString(),
        lastFund: lf,
        fundBlock,
        identity,
        walletBalWei: walletBal?.toString() ?? null,
        gasReserveWei: gasReserve.toString(),
        nowMs: Date.now()
      });

      console.info('[Bookish:Irys] funding decision', decision);

      // Handle decision
      if (decision.action === 'block') {
        logAppend('funding', 'decision-block', decision);
        if (decision.reason === 'fund-block-active') {
          const e = new Error('base-insufficient-funds-recent');
          e.code='base-insufficient-funds-recent';
          e.details=decision.details;
          throw e;
        } else if (decision.reason === 'insufficient-balance') {
          setFundBlock({ address: identity.address, reason: 'insufficient-base-funds-precheck' });
          const e = new Error('base-insufficient-funds');
          e.code='base-insufficient-funds';
          e.details=decision.details;
          throw e;
        }
      }

      if (decision.action === 'skip') {
        logAppend('funding', 'decision-skip', decision);
        return await retryCommit(decision.retryWindowMs);
      }

      // decision.action === 'fund': proceed with on-chain funding
      const amount = BigInt(decision.amountWei);
      logAppend('funding', 'decision-fund', { amountWei: amount.toString(), decision });

      // Protocol fee already collected before upload (flat per-upload fee).
      // Irys receives the full funding amount so uploads don't fail.

      // Attempt single on-chain funding (full amount)
      try{
        logAppend('funding', 'onchain-start', { amountWei: amount.toString(), identity });
        const res = await fundOnChain(amount.toString());
        logAppend('funding', 'onchain-success', { txHash: res.txId, amountWei: amount.toString() });
        recordLastFund({ ...identity, amountWei: amount.toString(), txHash: res.txId });
      }catch(err){
        // If base wallet has insufficient funds, set temporary block and surface a clear error
        const errCode = err?.code || err?.info?.error?.code || err?.name;
        const msg = String(err?.message||'');
        if(errCode==='INSUFFICIENT_FUNDS' || /insufficient funds/i.test(msg)){
          logAppend('funding', 'onchain-insuff', { errCode, msg });
          setFundBlock({ address: identity.address, reason: 'insufficient-base-funds' });
          const e = new Error('base-insufficient-funds'); e.code='base-insufficient-funds'; e.details=err; throw e;
        }
        logAppend('funding', 'onchain-error', { errCode, msg });
        throw err;
      }

      // Retry after funding (give node time to credit)
      return await retryCommit(decision.retryWindowMs);
    }
    if(!resp.ok){ console.info('[Bookish:Irys] upload error body', json||text); const e=new Error(`upload-http-${resp.status}`); e.details=json||text; throw e; }
    const id = json?.id || json?.dataId || json?.txId || json?.transactionId;
    if(!id) throw new Error('missing-id');
    return { id };
  }
  // Explicit signed path only (CDN-only)
  return await uploadSignedViaBundles(dataBytes, tags);
}
function getNodeUrl(){ return getIrysNode(); }
window.bookishIrys = { estimateCost, getIrysBalance, fund, fundOnChain, getFundingAddress, upload, getNodeUrl, getToken };
