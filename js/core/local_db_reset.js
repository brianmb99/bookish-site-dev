// local_db_reset.js — Shared helpers for wiping local IndexedDB state.
//
// Two local stores must live and die TOGETHER on every wipe path (#230):
//
//   1. The Bookish books cache (IndexedDB `bookish`, public/js/cache.js).
//   2. The Tarn SDK's delta-sync cursor (IndexedDB `tarn-sync-cursors`,
//      keyed per appId+dlk+type).
//
// If the books cache is wiped but the cursor survives, the next sign-in
// calls getEntriesSince() with a live cursor and receives only the
// post-cursor delta — an empty cache plus a tiny delta renders as "the
// library only has one recent book" (confirmed in production 2026-06-11,
// #230). The third store, `tarn-blob-cache` (per appId+dlk+txid), is
// wiped alongside for privacy: the next user on a shared browser should
// not inherit ciphertext blobs from the previous account.
//
// As of tarn dev commit 8d7d5b5 the SDK's `session.clear()` wipes its own
// per-account cursors + blob cache, so the explicit-logout path is covered
// twice. These helpers remain the only coverage for paths that never call
// `session.clear()` — e.g. the boot-path failed-session-restore in app.js —
// and harmless belt-and-suspenders everywhere else.
//
// BLOCKED-DELETE HAZARD (the #230-redux fix): `indexedDB.deleteDatabase()`
// BLOCKS while any other connection holds the database open — the SDK's
// own live cursor handle in this tab, or a second Bookish tab. The old
// implementation resolved on `onblocked` "so callers can't hang", which
// silently SKIPPED the deletion: books cache cleared, cursor survived,
// next sync delta-rendered one book. The fix inverts the order — CLEAR
// every object store first (a plain readwrite transaction, which works
// regardless of other open connections), then attempt the delete. A
// blocked delete is then harmless: an empty database survives, the
// cursor data does not. Clearing must come first for a second reason:
// `open()` issued AFTER a pending blocked delete queues behind it and
// would itself hang.

/** The Tarn SDK's per-account local IndexedDB databases. */
export const TARN_SDK_LOCAL_DBS = ['tarn-sync-cursors', 'tarn-blob-cache'];

// Cap on the clear-stores fallback so the wipe path can never stall the
// boot/login flow it runs in (e.g. another tab mid-versionchange).
const CLEAR_STORES_TIMEOUT_MS = 1500;

/**
 * Clear every object store in the named database. Unlike deleteDatabase,
 * this needs no exclusive access — it works while other tabs/handles hold
 * the DB open. Resolves true when all stores cleared, false on any
 * failure or timeout. Never rejects, never hangs.
 *
 * Note: open() creates the database (empty) if it doesn't exist; the
 * follow-up deleteDatabase in wipe flows removes it again, and an empty
 * DB is harmless regardless.
 *
 * @param {string} name
 * @param {IDBFactory} idb
 * @returns {Promise<boolean>}
 */
function clearAllObjectStores(name, idb) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), CLEAR_STORES_TIMEOUT_MS);
    try {
      const req = idb.open(name);
      req.onerror = () => settle(false);
      req.onsuccess = () => {
        const db = req.result;
        const close = () => { try { db.close(); } catch { /* ignore */ } };
        let names = [];
        try { names = Array.from(db.objectStoreNames || []); } catch { names = []; }
        if (names.length === 0) { close(); settle(true); return; }
        let tx;
        try {
          tx = db.transaction(names, 'readwrite');
        } catch {
          close();
          settle(false);
          return;
        }
        tx.oncomplete = () => { close(); settle(true); };
        tx.onerror = () => { close(); settle(false); };
        tx.onabort = () => { close(); settle(false); };
        for (const n of names) {
          try { tx.objectStore(n).clear(); } catch { /* ignore */ }
        }
      };
    } catch {
      settle(false);
    }
  });
}

/**
 * Wipe an IndexedDB database's DATA, then best-effort delete the database
 * itself. The data clear is the correctness-bearing step (see module
 * header); the delete is cosmetic cleanup that may be skipped when another
 * connection blocks it. Resolves on success, error, block, or timeout —
 * callers can't hang. Silent — failures are non-fatal.
 *
 * @param {string} name
 * @param {{ idb?: IDBFactory }} [opts] — injectable for tests
 * @returns {Promise<void>}
 */
export async function deleteIndexedDb(name, { idb = globalThis.indexedDB } = {}) {
  // Step 1: clear contents — works even with other open connections.
  try {
    await clearAllObjectStores(name, idb);
  } catch { /* never happens (clearAllObjectStores doesn't reject) */ }

  // Step 2: try to remove the (now-empty) database. Blocked is acceptable.
  await new Promise((resolve) => {
    try {
      const req = idb.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => {
        // Another connection holds the DB open; deletion stays pending in
        // the browser until they close. The stores are already cleared, so
        // the #230 invariant holds either way.
        console.warn(`[Bookish:LocalDbReset] deleteDatabase('${name}') blocked by an open connection; contents already cleared`);
        resolve();
      };
    } catch { resolve(); }
  });
}

/**
 * Delete the Tarn SDK's per-account local databases (sync cursors + blob
 * cache). Call this whenever the Bookish books cache is wiped or the
 * device switches accounts — cache and cursor must stay consistent (#230).
 *
 * @param {{ deleteDb?: (name: string) => Promise<void> }} [opts]
 * @returns {Promise<void>}
 */
export async function deleteTarnSdkLocalDbs({ deleteDb = deleteIndexedDb } = {}) {
  for (const name of TARN_SDK_LOCAL_DBS) {
    await deleteDb(name);
  }
}
