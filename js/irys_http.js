// irys_http.js - Pure HTTP helpers for Irys endpoints (browser + Node-compatible)

function getIrysNode(){
  // Happy path: default node unless app hardcodes one
  return (typeof window!=='undefined' && window.BOOKISH_IRYS_URL) || 'https://node1.irys.xyz';
}

function getToken(){
  // Happy path default; detection will refine
  if(typeof window!=='undefined' && window.__bookishResolvedToken) return window.__bookishResolvedToken;
  return 'base';
}

async function fetchJSON(url, init){
  const r = await fetch(url, init);
  const text = await r.text();
  let json=null; try{ json = text? JSON.parse(text):null; }catch{}
  return { ok:r.ok, status:r.status, json, text };
}

async function getNodeInfo(){
  const r1 = await fetchJSON(`${getIrysNode()}/info`);
  let info = r1.ok ? (r1.json||{}) : {};
  if(!r1.ok){
    const r2 = await fetchJSON(`${getIrysNode()}/info/${getToken()}`);
    if(r2.ok) info = r2.json||{}; else throw new Error('node-info-failed:'+r1.status+','+r2.status);
  }
  try{ console.info('[Bookish:Irys] http:/info keys', Object.keys((info && (info.addresses||info.fundingAddresses||info.wallets||info.currencies))||{})); }catch{}
  return info;
}

async function probePrice(token){
  const r = await fetch(`${getIrysNode()}/price/${token}/1`, { method:'GET' });
  return r.ok;
}

async function detectToken(){
  // No user override in happy path
  try{
    const info = await getNodeInfo();
    const map = (info && (info.addresses || info.fundingAddresses || info.wallets || info.currencies)) || {};
    const keys = Object.keys(map);
    const pref = ['base','base-eth','ethereum:base'];
    const candidates = [...pref.filter(k=>keys.includes(k)), ...keys.filter(k=>!pref.includes(k))];
    for(const k of candidates){ if(await probePrice(k)){ try{ if(typeof window!=='undefined') window.__bookishResolvedToken=k; }catch{} console.info('[Bookish:Irys] http:token resolve', k); return k; } }
  }catch{}
  const blind = ['base','base-eth','ethereum:base'];
  for(const k of blind){ if(await probePrice(k)){ try{ if(typeof window!=='undefined') window.__bookishResolvedToken=k; }catch{} console.info('[Bookish:Irys] http:token blind', k); return k; } }
  try{ if(typeof window!=='undefined') window.__bookishResolvedToken='base'; }catch{}
  return 'base';
}

async function resolveToken(){
  if(typeof window!=='undefined' && window.__bookishResolvedToken) return window.__bookishResolvedToken;
  return await detectToken();
}

async function estimateCost(byteLength){
  let tk = await resolveToken();
  let url = `${getIrysNode()}/price/${tk}/${byteLength}`;
  console.info('[Bookish:Irys] http:price get', url);
  let r = await fetchJSON(url);
  if(r.ok) return BigInt(r.json);
  tk = await detectToken();
  url = `${getIrysNode()}/price/${tk}/${byteLength}`;
  console.info('[Bookish:Irys] http:price retry', url);
  r = await fetchJSON(url);
  if(r.ok) return BigInt(r.json);
  throw new Error('price-failed');
}

async function getIrysBalance(address){
  const urlBase = getIrysNode();
  const tryPattern = async (pattern)=>{
    const res = await fetchJSON(pattern);
    if(res.ok) return res;
    return null;
  };
  const use = async (tk)=>{
    const patterns = [
      `${urlBase}/account/balance/${tk}/${address}`,
      `${urlBase}/account/balance/${address}?currency=${encodeURIComponent(tk)}`,
      `${urlBase}/account/balance/${address}`
    ];
    for(const p of patterns){ console.info('[Bookish:Irys] http:balance try', p); const r = await tryPattern(p); if(r){ console.info('[Bookish:Irys] http:balance ok', p); return r; } else { console.info('[Bookish:Irys] http:balance fail', p); } }
    return null;
  };
  let tk = await resolveToken();
  let r = await use(tk);
  if(!r){ tk = await detectToken(); r = await use(tk); }
  if(r){
    const balStr = String(r.json?.balance ?? '0');
    const preStr = String(r.json?.prepaid ?? '0');
    return { balance: BigInt(balStr), prepaid: BigInt(preStr), token: tk };
  }
  // Node doesn't expose a balance endpoint; report unknown instead of misleading 0
  return { balance: null, prepaid: null, token: tk, unknown: true };
}

async function getFundingAddress(){
  const info = await getNodeInfo().catch(()=>null);
  const addrMap = (info && (info.addresses || info.fundingAddresses || info.wallets || info.currencies)) || {};
  const t = await resolveToken();
  let fundAddr = null;
  if(addrMap[t]?.address){ fundAddr = addrMap[t].address; }
  else if(typeof addrMap[t]==='string'){ fundAddr = addrMap[t]; }
  console.info('[Bookish:Irys] http:funding address', { token:t, address: fundAddr });
  try{ if(!fundAddr && typeof localStorage!=='undefined'){ const o=localStorage.getItem('bookish.irysFundAddr'); if(o) fundAddr=o; } }catch{}
  if(!fundAddr && typeof window!=='undefined' && typeof window.BOOKISH_IRYS_FUND_ADDR==='string') fundAddr = window.BOOKISH_IRYS_FUND_ADDR;
  return fundAddr;
}

function getNodeUrl(){ return getIrysNode(); }

const api = { getIrysNode, getToken, resolveToken, detectToken, getNodeInfo, estimateCost, getIrysBalance, getFundingAddress, getNodeUrl };
export { getIrysNode, getToken, resolveToken, detectToken, getNodeInfo, estimateCost, getIrysBalance, getFundingAddress, getNodeUrl };
export default api;
