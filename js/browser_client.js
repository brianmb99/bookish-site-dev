// browser_client.js - minimal browser-only Bookish client (serverless mode)
// Uses WebCrypto for AES-256-GCM; no Arweave JWK required.
// Layout of encrypted payload: iv(12) | tag(16) | ciphertext (matches Node implementation)

import { hexToBytes, base64ToBytes, bytesToBase64, importAesKey, encryptJsonToBytes, decryptBytesToJson } from './core/crypto_core.js';

export async function deriveBookId({ isbn, title, author, edition }) {
  if (isbn && isbn.trim()) return `isbn:${isbn.trim()}`;
  const s = `${title ?? ''}|${author ?? ''}|${edition ?? ''}`.toLowerCase();
  const enc = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const hex = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  return `hash:${hex}`;
}

export async function createBrowserClient({ jwk=null, symKeyHex, appName='bookish', schemaVersion='0.1.0', keyId='default', useIrysProxy=false }){
  if(!symKeyHex) throw new Error('missing symKeyHex');
  const symKey = hexToBytes(symKeyHex.trim());
  const aesKey = await importAesKey(symKey);
  // Identity: use EVM address derived from bookish.sym
  async function address(){ try{ return await (window.bookishWallet?.getAddress?.()); }catch{ return null; } }

  function encJson(obj){
    return encryptJsonToBytes(aesKey, obj);
  }
  async function decBytes(bytes){
    try {
      return await decryptBytesToJson(aesKey, bytes);
    } catch(e) {
      throw new Error('decrypt failed');
    }
  }

  function addCommonTags(tx){
    tx.addTag('App-Name', appName);
    tx.addTag('Schema-Name', 'reading');
    tx.addTag('Schema-Version', schemaVersion);
    tx.addTag('Visibility', 'private');
    tx.addTag('Enc', 'aes-256-gcm');
    tx.addTag('Key-Id', keyId);
    tx.addTag('Content-Type','application/octet-stream');
  }

  function detectMime(raw){
    if(raw.length>=3 && raw[0]===0xFF && raw[1]===0xD8 && raw[2]===0xFF) return 'image/jpeg';
    if(raw.length>=8 && raw[0]===0x89 && raw[1]===0x50 && raw[2]===0x4E && raw[3]===0x47) return 'image/png';
    return undefined;
  }

  // Estimate encrypted payload size for a prospective entry (AES-GCM adds 12 iv + 16 tag)
  async function estimateEntryBytes(entry){
    const e = { ...entry };
    e.schema='reading'; e.version='0.1.0';
    if(!e.bookId){ e.bookId = await deriveBookId(e); }
    const pt = new TextEncoder().encode(JSON.stringify(e));
    return 12 + 16 + pt.length; // iv + tag + ciphertext
  }

  async function uploadEntry(entry,{ extraTags=[] }={}){
    entry.schema='reading'; entry.version='0.1.0';
    if(!entry.bookId){ entry.bookId = await deriveBookId(entry); }
    if(entry.coverImage){
      if(!entry.mimeType){
        try { const raw = base64ToBytes(entry.coverImage); const mt = detectMime(raw); if(mt) entry.mimeType = mt; } catch{}
      }
      if(!entry.mimeType) throw new Error('coverImage mimeType missing');
    }
    const payload = await encJson(entry);
    const tags = [];
    // Build tags array in a portable form for proxy (and we also add to tx for direct path)
    addCommonTags({ addTag: (n,v)=> tags.push({ name:n, value:v }) });
    try{ const pubAddr = await (window.bookishWallet?.getAddress?.()); if(pubAddr) tags.push({ name:'Pub-Addr', value: String(pubAddr).toLowerCase() }); }catch{}
    extraTags.forEach(t=> tags.push({ name:t.name, value:t.value }));

    // vNext: Browser Irys client handles funding + upload; no Arweave or proxy fallback
    if(!window.bookishIrys) { const e = new Error('Irys required'); e.code='irys-required'; throw e; }
    try {
      const res = await window.bookishIrys.upload(payload, tags);
      return { txid: res.id, status: 200, irys: true };
    } catch(err){ throw err; }
  }

  async function fetchBytes(txid){
    // Prefer Irys gateway first for faster availability
    try {
      const rI = await fetch(`https://gateway.irys.xyz/${txid}`);
      if (rI.ok){
        window.bookishNet = window.bookishNet||{reads:{irys:0, arweave:0, errors:0}};
        window.bookishNet.reads.irys++; if(window.BOOKISH_DEBUG) console.debug('[Bookish] read from Irys', txid);
        return new Uint8Array(await rI.arrayBuffer());
      }
    } catch{ /* ignore */ }
    // Fallback to public Arweave if Irys misses
    try {
      const rA = await fetch(`https://arweave.net/${txid}`);
      if (rA.ok){
        window.bookishNet = window.bookishNet||{reads:{irys:0, arweave:0, errors:0}};
        window.bookishNet.reads.arweave++; if(window.BOOKISH_DEBUG) console.debug('[Bookish] read from Arweave', txid);
        return new Uint8Array(await rA.arrayBuffer());
      }
    } catch{ /* ignore */ }
    window.bookishNet = window.bookishNet||{reads:{irys:0, arweave:0, errors:0}};
    window.bookishNet.reads.errors++; if(window.BOOKISH_DEBUG) console.debug('[Bookish] read failed', txid);
    throw new Error('fetch '+txid+': irys+arweave failed');
  }
  async function decryptTx(txid){ const bytes = await fetchBytes(txid); return decBytes(bytes); }

  // --- Availability probes (best-effort; cached per session) ---
  const availCache = new Map(); // key: txid -> { irys:bool, arweave:bool, t:number }
  async function probeGateway(url){ try{ const r = await fetch(url, { method:'HEAD', cache:'no-store' }); return r.ok; } catch{ return false; } }
  function inc(kind){ try{ window.bookishNet = window.bookishNet||{reads:{irys:0, arweave:0, errors:0}}; const key = kind+"InFlight"; window.bookishNet[key] = (window.bookishNet[key]||0)+1; }catch{} }
  function dec(kind){ try{ const key = kind+"InFlight"; window.bookishNet[key] = Math.max(0, (window.bookishNet[key]||0)-1); }catch{} }
  async function probeGatewayTracked(kind, url){
    inc(kind);
    try{ return await probeGateway(url); }
    finally{ dec(kind); }
  }
  async function probeAvailability(txid){
    const hit = availCache.get(txid); const now=Date.now();
    if(hit && (now-hit.t)<60000) return hit; // 60s cache
    // record when we actually perform a fresh probe for UI countdowns
    try{
      window.bookishNet = window.bookishNet||{reads:{irys:0, arweave:0, errors:0}};
      window.bookishNet.lastProbeAt = now;
      window.bookishNet.nextProbeAt = now + 60000;
    }catch{}
    const [pi, pa] = await Promise.all([
      probeGatewayTracked('irys', `https://gateway.irys.xyz/${txid}`),
      probeGatewayTracked('arweave', `https://arweave.net/${txid}`)
    ]);
    const rec = { irys: !!pi, arweave: !!pa, t: now };
    availCache.set(txid, rec);
    return rec;
  }

  // expose probe on window for UI
  window.bookishNet = window.bookishNet || { reads:{ irys:0, arweave:0, errors:0 } };
  window.bookishNet.probeAvailability = probeAvailability;
  window.bookishNet.forceProbe = async (txid)=>{ availCache.delete(txid); return probeAvailability(txid); };

  async function searchByOwner(owner,{ limit=25, cursor }={}){
    // Prefer tag-based discovery using Pub-Addr (EVM address). Owner fallback is optional now.
    const pub = (await (window.bookishWallet?.getAddress?.()))?.toLowerCase();
    const tags=[
      {name:'App-Name', values:[appName]},
      {name:'Schema-Name', values:['reading']},
      {name:'Visibility', values:['private']},
      ...(pub? [{name:'Pub-Addr', values:[pub]}]: [])
    ];
    const q = owner ? `query($after:String,$first:Int,$tags:[TagFilter!],$owners:[String!]){
      t1: transactions(after:$after,first:$first,sort:HEIGHT_DESC,tags:$tags){pageInfo{hasNextPage}edges{cursor node{id tags{name value} block{timestamp height}}}}
      t2: transactions(after:$after,first:$first,sort:HEIGHT_DESC,owners:$owners,tags:$tags){pageInfo{hasNextPage}edges{cursor node{id tags{name value} block{timestamp height}}}}
    }` : `query($after:String,$first:Int,$tags:[TagFilter!]){
      t1: transactions(after:$after,first:$first,sort:HEIGHT_DESC,tags:$tags){pageInfo{hasNextPage}edges{cursor node{id tags{name value} block{timestamp height}}}}
    }`;
    const variables = owner ? { after: cursor??null, first: limit, tags, owners:[owner] } : { after: cursor??null, first: limit, tags };
    const resp = await fetch('https://arweave.net/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q,variables})});
    const json = await resp.json(); if(!json.data) throw new Error('graphql');
    const edges1 = json.data.t1?.edges||[];
    const edges2 = json.data.t2?.edges||[];
    const seen=new Set();
    const merged=[...edges1, ...edges2].filter(e=>{ if(seen.has(e.node.id)) return false; seen.add(e.node.id); return true; });
    const hasNext = (json.data.t1?.pageInfo?.hasNextPage) || (json.data.t2?.pageInfo?.hasNextPage);
    return { edges: merged, pageInfo: { hasNextPage: !!hasNext } };
  }

  function isTomb(e){ return e.node.tags?.some(t=>t.name==='Op' && t.value==='tombstone'); }
  function refOf(e){ return e.node.tags?.find(t=>t.name==='Ref')?.value; }

  function computeLiveSets(allEdges){
    const tombstones = allEdges.filter(isTomb).map(e=>({ txid:e.node.id, ref: refOf(e) }));
    const superseded = new Set(allEdges.filter(e=>e.node.tags?.some(t=>t.name==='Prev')).map(e=> e.node.tags.find(t=>t.name==='Prev')?.value).filter(Boolean));
    const tombRefs = new Set(tombstones.map(t=>t.ref).filter(Boolean));
    const liveEdges = allEdges.filter(e=>{ if(isTomb(e)) return false; if(tombRefs.has(e.node.id)) return false; if(superseded.has(e.node.id)) return false; return true; });
    return { liveEdges, tombstones };
  }

  async function tombstone(priorTxid,{ note }={}){
    const content = await encJson({ op:'tombstone', ref:priorTxid, note:note||'' });
    const tags = []; addCommonTags({ addTag:(n,v)=>tags.push({name:n,value:v}) });
    tags.push({ name:'Op', value:'tombstone' }); tags.push({ name:'Ref', value: priorTxid });
    try{ const pubAddr = await (window.bookishWallet?.getAddress?.()); if(pubAddr) tags.push({ name:'Pub-Addr', value: String(pubAddr).toLowerCase() }); }catch{}
    if(!window.bookishIrys) { const e = new Error('Irys required'); e.code='irys-required'; throw e; }
    const res = await window.bookishIrys.upload(content, tags);
    return { txid: res.id, status: 200 };
  }

  return { address, uploadEntry, decryptTx, searchByOwner, computeLiveSets, tombstone, estimateEntryBytes };
}

// Convenience global for ad-hoc debugging
window.bookishBrowserClient = { createBrowserClient, deriveBookId };
// expose estimator for non-module consumers
window.bookishEstimate = window.bookishEstimate || {};
window.bookishEstimate.entryBytes = async (entry)=>{
  try{
    // Need a client instance to access estimator; re-create minimal for AES key path
    if(typeof createBrowserClient!=='function') return null;
    // The estimator here is independent, but we can reuse deriveBookId directly
    const e = { ...entry };
    e.schema='reading'; e.version='0.1.0';
    if(!e.bookId){ e.bookId = await deriveBookId(e); }
    const pt = new TextEncoder().encode(JSON.stringify(e));
    return 12 + 16 + pt.length;
  }catch{ return null; }
};
