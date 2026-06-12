// cache.js - IndexedDB based local cache & sync layer
import { computeContentHash as coreComputeContentHash, detectDuplicate as coreDetectDuplicate, applyRemote as coreApplyRemote, compactDuplicates as coreCompactDuplicates } from './core/cache_core.js';
import { GUEST_SCOPE, matchesActiveScope, isAdoptableGuestEntry, shouldPruneEntry } from './core/scope_core.js';
import { debugLog } from './core/debug_log.js';

(function(){
  const DB_NAME='bookish';
  // v2 (#231): entries carry a per-account `scope` field (a Tarn dlk, or
  // 'guest' for logged-out books) + a non-unique index on it. Existing
  // entries are tagged lazily at boot via migrateUnscopedEntries() — the
  // upgrade handler can't know the session state because initCache() runs
  // before tarnService.init() (see initCacheLayer in app.js).
  const DB_VERSION=2;
  const ENTRY_STORE='entries';
  const OPS_STORE='ops'; // future use (queued mutations)

  // The account scope stamped on writes and filtered on reads. 'guest'
  // until app.js / account_ui.js thread the real scope in via
  // setActiveScope() (boot, sign-in, sign-up, logout). See the flow
  // documentation in core/account_scope.js.
  let activeScope = GUEST_SCOPE;
  function setActiveScope(scope){ activeScope = scope || GUEST_SCOPE; }
  function getActiveScope(){ return activeScope; }

  function openDB(){
    return new Promise((res,rej)=>{
      const req=indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded=e=>{
        const db=req.result;
        let entryStore;
        if(!db.objectStoreNames.contains(ENTRY_STORE)){
          entryStore=db.createObjectStore(ENTRY_STORE,{keyPath:'id'});
          entryStore.createIndex('txid','txid',{unique:true});
          entryStore.createIndex('contentHash','contentHash',{unique:false});
        } else {
          // v1 → v2 upgrade: reuse the existing store via the
          // versionchange transaction to add the new index.
          entryStore=req.transaction.objectStore(ENTRY_STORE);
        }
        if(!entryStore.indexNames.contains('scope')){
          entryStore.createIndex('scope','scope',{unique:false});
        }
        if(!db.objectStoreNames.contains(OPS_STORE)){
          db.createObjectStore(OPS_STORE,{keyPath:'id'});
        }
      };
      req.onsuccess=()=>res(req.result);
      req.onerror=()=>rej(req.error);
    });
  }

  async function withStore(mode, storeName, fn){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(storeName, mode);
      tx.onabort=()=>rej(tx.error);
      tx.onerror=()=>rej(tx.error);
      const store=tx.objectStore(storeName);
      Promise.resolve(fn(store)).then(val=>{ tx.oncomplete=()=>res(val); }).catch(rej);
    });
  }

  async function computeContentHash(entry){ return coreComputeContentHash(entry); }
  async function ensureContentHash(e){ if(!e.contentHash || !e.contentHash.startsWith('sha256-')){ e.contentHash=await computeContentHash(e); } return e; }
  // Every write stamps the active scope (#231). Re-putting an entry under
  // a new active scope intentionally re-scopes it — that is how a guest's
  // pending books are adopted when their queued creates replay after
  // sign-in (BookRepository.replayPending → replaceProvisional → putEntry).
  async function putEntry(e){ e.scope=activeScope; await ensureContentHash(e); return withStore('readwrite', ENTRY_STORE, store=> store.put(e)); }
  // Hash BEFORE opening the transaction: an `await` inside the tx callback
  // suspends past the IDB transaction's lifetime, so the late store.put()s
  // were silently dropped whenever an entry still needed its contentHash
  // computed (latent pre-#231 bug, exposed by the scope-stamping test).
  async function bulkPut(entries){
    for(const e of entries){ e.scope=activeScope; await ensureContentHash(e); }
    return withStore('readwrite', ENTRY_STORE, store=>{ entries.forEach(e=> store.put(e)); });
  }
  async function findByContentHash(h){ if(!h) return null; return withStore('readonly', ENTRY_STORE, store=> new Promise(r=>{ const idx=store.index('contentHash'); let found=null; const req=idx.openCursor(); req.onsuccess=e=>{ const cur=e.target.result; if(cur){ if(cur.value.contentHash===h && matchesActiveScope(cur.value, activeScope)){ found=cur.value; r(found); return; } cur.continue(); } else r(found); }; })); }
  async function getAllActive(){
    return withStore('readonly', ENTRY_STORE, store=>{
      return new Promise(r=>{
        const entries=[]; const req=store.openCursor();
        req.onsuccess=e=>{ const cur=e.target.result; if(cur){ if(cur.value.status!=='tombstoned' && matchesActiveScope(cur.value, activeScope)) entries.push(cur.value); cur.continue(); } else r(entries); };
      });
    });
  }
  async function markTombstoned(txid){ if(!txid) return; const rec=await findByTxid(txid); if(rec){ rec.status='tombstoned'; rec.tombstonedAt=Date.now(); await putEntry(rec); } }
  // Tombstone GC intentionally ignores scope: expired tombstones are
  // garbage in every scope, and deleting them never affects what renders.
  async function removeOldTombstones(days=7){
    const cutoff=Date.now()-days*86400000;
    return withStore('readwrite', ENTRY_STORE, store=> new Promise(r=>{
      const req=store.openCursor();
      req.onsuccess=e=>{ const cur=e.target.result; if(cur){ const v=cur.value; if(v.status==='tombstoned' && v.tombstonedAt && v.tombstonedAt<cutoff){ cur.delete(); } cur.continue(); } else r(); };
    }));
  }

  async function applyRemote(remoteList, tombstones){
    const localAll = await listAllRaw();
    debugLog('[Bookish:Cache] applyRemote: local entries:', localAll.length, 'remote:', remoteList.length, 'tombstones:', tombstones.length);
    const result = await coreApplyRemote(remoteList, tombstones, localAll);
    debugLog('[Bookish:Cache] applyRemote result: add:', result.toAdd.length, 'replace:', result.toReplace.length, 'update:', result.toUpdate.length, 'tombstone:', result.toTombstone.length);

    // Apply changes to IndexedDB
    for(const entry of result.toUpdate){
      await putEntry(entry);
    }
    for(const entry of result.toTombstone){
      await putEntry(entry);
    }
    for(const { prevId, entry } of (result.toReplace || [])){
      await deleteById(prevId);
      await putEntry(entry);
    }
    if(result.toAdd.length) await bulkPut(result.toAdd);

    return getAllActive();
  }
  async function detectDuplicate(payload){ const all=await listAllRaw(); return coreDetectDuplicate(payload, all); }
  async function deleteById(id){ if(!id) return; return withStore('readwrite', ENTRY_STORE, store=> store.delete(id)); }
  async function compactDuplicates(){
    const all=await listAllRaw();
    const result = coreCompactDuplicates(all);
    for(const id of result.toDelete){
      await deleteById(id);
    }
  }
  async function replaceProvisional(oldId, rec){ if(oldId && oldId!==rec.id){ await deleteById(oldId); } await putEntry(rec); }
  // "Raw" = includes tombstones and pending entries — but still scoped to
  // the active account (#231): BookRepository.sync() builds its working
  // set from this, and a cross-scope working set would re-display another
  // account's books after the first delta sync.
  async function listAllRaw(){
    return withStore('readonly', ENTRY_STORE, store=> new Promise(r=>{ const out=[]; const req=store.openCursor(); req.onsuccess=e=>{ const cur=e.target.result; if(cur){ if(matchesActiveScope(cur.value, activeScope)) out.push(cur.value); cur.continue(); } else r(out); }; }));
  }
  async function findByTxid(txid){ if(!txid) return null; return withStore('readonly', ENTRY_STORE, store=> new Promise(r=>{ const idx=store.index('txid'); const req=idx.get(txid); req.onsuccess=()=>{ const rec=req.result||null; r(rec && matchesActiveScope(rec, activeScope) ? rec : null); }; req.onerror=()=>r(null); })); }
  async function initCache(){ await openDB(); }

  // --- Account scoping maintenance (#231) ---
  // Cursor walks over ALL entries regardless of the active scope; per-entry
  // decisions live in core/scope_core.js (pure, unit-tested).

  /** Shared readwrite walk: visit(value) returns 'delete', an updated
   *  object to put back, or undefined (no change). Resolves with the
   *  number of entries changed. */
  function walkEntriesRW(visit){
    return withStore('readwrite', ENTRY_STORE, store=> new Promise(r=>{
      let changed=0; const req=store.openCursor();
      req.onsuccess=e=>{
        const cur=e.target.result;
        if(cur){
          const action=visit(cur.value);
          if(action==='delete'){ cur.delete(); changed++; }
          else if(action && typeof action==='object'){ cur.update(action); changed++; }
          cur.continue();
        } else r(changed);
      };
    }));
  }

  /** One-time boot migration: tag legacy entries that predate #231 with
   *  the boot scope (the restored session's dlk, else 'guest'). Never
   *  deletes anything. Idempotent — scoped entries are left untouched. */
  async function migrateUnscopedEntries(scope){
    const tagged = await walkEntriesRW(v=> v.scope==null ? { ...v, scope } : undefined);
    if(tagged) debugLog('[Bookish:Cache] migrated', tagged, 'unscoped entries → scope', scope);
    return tagged;
  }

  /** Privacy prune (sign-in): delete entries scoped to OTHER accounts.
   *  Guest and legacy unscoped entries are always kept (see scope_core). */
  async function pruneOtherScopes(keepScopes){
    const pruned = await walkEntriesRW(v=> shouldPruneEntry(v, keepScopes) ? 'delete' : undefined);
    if(pruned) debugLog('[Bookish:Cache] pruned', pruned, 'entries from other account scopes');
    return pruned;
  }

  /** Guest → account adoption (sign-in/sign-up): re-scope the guest's
   *  locally-created, never-synced books to the account. Their queued
   *  'create' ops upload them on the first sync. Remote-backed entries
   *  tagged 'guest' (prior-account residue from the one-time migration)
   *  are NOT adopted — see scope_core.isAdoptableGuestEntry. */
  async function adoptGuestEntries(scope){
    const adopted = await walkEntriesRW(v=> isAdoptableGuestEntry(v) ? { ...v, scope } : undefined);
    if(adopted) debugLog('[Bookish:Cache] adopted', adopted, 'guest entries → scope', scope);
    return adopted;
  }

  // --- Ops queue (minimal) ---
  async function queueOp(op){
    if((op?.type === 'edit' || op?.type === 'delete') && op.bookId){
      const ops = await listOps();
      const existing = ops.find(o => o.type === op.type && o.bookId === op.bookId);
      if(existing){
        op.id = existing.id;
        op.createdAt = existing.createdAt;
      }
    }
    if(!op.id) op.id='op-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    op.createdAt=op.createdAt||Date.now();
    await withStore('readwrite', OPS_STORE, store=> store.put(op));
    return op.id;
  }
  async function listOps(){
    return withStore('readonly', OPS_STORE, store=> new Promise(r=>{ const out=[]; const req=store.openCursor(); req.onsuccess=e=>{ const cur=e.target.result; if(cur){ out.push(cur.value); cur.continue(); } else { out.sort((a,b)=>a.createdAt-b.createdAt); r(out); } }; }));
  }
  async function removeOp(id){ if(!id) return; return withStore('readwrite', OPS_STORE, store=> store.delete(id)); }
  async function removeEditOp(bookId){
    if(!bookId) return;
    const ops = await listOps();
    const edits = ops.filter(op => op.type === 'edit' && op.bookId === bookId);
    for(const op of edits){ await removeOp(op.id); }
  }
  async function removeDeleteOp(bookId){
    if(!bookId) return;
    const ops = await listOps();
    const deletes = ops.filter(op => op.type === 'delete' && op.bookId === bookId);
    for(const op of deletes){ await removeOp(op.id); }
  }
  async function clearAll(){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction([ENTRY_STORE, OPS_STORE], 'readwrite');
      tx.oncomplete=()=>res();
      tx.onerror=()=>rej(tx.error);
      tx.onabort=()=>rej(tx.error);
      tx.objectStore(ENTRY_STORE).clear();
      tx.objectStore(OPS_STORE).clear();
    });
  }

  window.bookishCache={
    initCache,getAllActive,putEntry,bulkPut,applyRemote,findByTxid,markTombstoned,removeOldTombstones,listAllRaw,computeContentHash,detectDuplicate,deleteById,compactDuplicates,replaceProvisional,
    queueOp,listOps,removeOp,removeEditOp,removeDeleteOp,clearAll,
    setActiveScope,getActiveScope,migrateUnscopedEntries,pruneOtherScopes,adoptGuestEntries
  };
})();
