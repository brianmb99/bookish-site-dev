// browser_client.js - minimal browser-only Bookish client (serverless mode)
// Uses WebCrypto for AES-256-GCM; no Arweave JWK required.
// Layout of encrypted payload: iv(12) | tag(16) | ciphertext (matches Node implementation)

import { hexToBytes, base64ToBytes, bytesToBase64, importAesKey, encryptJsonToBytes, decryptBytesToJson } from './core/crypto_core.js';
import { searchBookEntries, computeLiveSets as coreComputeLiveSets } from './core/arweave_query.js';

/**
 * Derive a stable bookId for a reading event.
 * Includes createdAt so re-reads of the same book get distinct IDs.
 * The result is stored in the entry and carried forward on edits
 * (payload.bookId = old.bookId), so it never changes for a given entry.
 */
export async function deriveBookId({ isbn, title, author, edition, createdAt }) {
  // createdAt anchors the ID to a specific reading event
  const ts = createdAt ? String(createdAt) : String(Date.now());
  if (isbn && isbn.trim()) return `isbn:${isbn.trim()}:${ts}`;
  const s = `${title ?? ''}|${author ?? ''}|${edition ?? ''}|${ts}`.toLowerCase();
  const enc = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const hex = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  return `hash:${hex}`;
}

export async function createBrowserClient({ jwk=null, symKeyHex, appName='bookish', schemaVersion='0.1.0', keyId='default' }={}){
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

    if(!window.bookishUpload) { const e = new Error('Upload client required'); e.code='upload-required'; throw e; }
    try {
      const res = await window.bookishUpload.upload(payload, tags);
      return { txid: res.id, status: 200 };
    } catch(err){ throw err; }
  }

  async function fetchBytes(txid){
    try {
      const rA = await fetch(`https://arweave.net/${txid}`);
      if (rA.ok){
        window.bookishNet = window.bookishNet||{reads:{arweave:0, turbo:0, errors:0}};
        window.bookishNet.reads.arweave++; if(window.BOOKISH_DEBUG) console.debug('[Bookish] read from Arweave', txid);
        return new Uint8Array(await rA.arrayBuffer());
      }
    } catch{ /* ignore */ }
    try {
      const rT = await fetch(`https://turbo-gateway.com/${txid}`);
      if (rT.ok){
        window.bookishNet = window.bookishNet||{reads:{arweave:0, turbo:0, errors:0}};
        window.bookishNet.reads.turbo++; if(window.BOOKISH_DEBUG) console.debug('[Bookish] read from Turbo cache', txid);
        return new Uint8Array(await rT.arrayBuffer());
      }
    } catch{ /* ignore */ }
    window.bookishNet = window.bookishNet||{reads:{arweave:0, turbo:0, errors:0}};
    window.bookishNet.reads.errors++; if(window.BOOKISH_DEBUG) console.debug('[Bookish] read failed', txid);
    throw new Error('fetch '+txid+': arweave+turbo failed');
  }
  async function decryptTx(txid){ const bytes = await fetchBytes(txid); return decBytes(bytes); }

  // --- Availability probes (best-effort; cached per session) ---
  const availCache = new Map();
  async function probeGateway(url){ try{ const r = await fetch(url, { method:'HEAD', cache:'no-store' }); return r.ok; } catch{ return false; } }
  function inc(kind){ try{ window.bookishNet = window.bookishNet||{reads:{arweave:0, turbo:0, errors:0}}; const key = kind+"InFlight"; window.bookishNet[key] = (window.bookishNet[key]||0)+1; }catch{} }
  function dec(kind){ try{ const key = kind+"InFlight"; window.bookishNet[key] = Math.max(0, (window.bookishNet[key]||0)-1); }catch{} }
  async function probeGatewayTracked(kind, url){
    inc(kind);
    try{ return await probeGateway(url); }
    finally{ dec(kind); }
  }
  async function probeAvailability(txid){
    const hit = availCache.get(txid); const now=Date.now();
    if(hit && (now-hit.t)<60000) return hit; // 60s cache
    try{
      window.bookishNet = window.bookishNet||{reads:{arweave:0, turbo:0, errors:0}};
      window.bookishNet.lastProbeAt = now;
      window.bookishNet.nextProbeAt = now + 60000;
    }catch{}
    const pa = await probeGatewayTracked('arweave', `https://arweave.net/${txid}`);
    let pt = false;
    if (!pa) {
      pt = await probeGatewayTracked('turbo', `https://turbo-gateway.com/${txid}`);
    }
    const rec = { arweave: !!pa, turbo: !!pt, t: now };
    availCache.set(txid, rec);
    return rec;
  }

  window.bookishNet = window.bookishNet || { reads:{ arweave:0, turbo:0, errors:0 } };
  window.bookishNet.probeAvailability = probeAvailability;
  window.bookishNet.forceProbe = async (txid)=>{ availCache.delete(txid); return probeAvailability(txid); };

  async function searchByOwner(owner, { limit = 25, cursor } = {}) {
    const pub = (await (window.bookishWallet?.getAddress?.()))?.toLowerCase();
    return searchBookEntries(pub, { owner, limit, cursor, appName });
  }

  function computeLiveSets(allEdges) {
    return coreComputeLiveSets(allEdges);
  }

  async function tombstone(priorTxid,{ note }={}){
    const content = await encJson({ op:'tombstone', ref:priorTxid, note:note||'' });
    const tags = []; addCommonTags({ addTag:(n,v)=>tags.push({name:n,value:v}) });
    tags.push({ name:'Op', value:'tombstone' }); tags.push({ name:'Ref', value: priorTxid });
    try{ const pubAddr = await (window.bookishWallet?.getAddress?.()); if(pubAddr) tags.push({ name:'Pub-Addr', value: String(pubAddr).toLowerCase() }); }catch{}
    if(!window.bookishUpload) { const e = new Error('Upload client required'); e.code='upload-required'; throw e; }
    const res = await window.bookishUpload.upload(content, tags);
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
