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

/** The Tarn SDK's per-account local IndexedDB databases. */
export const TARN_SDK_LOCAL_DBS = ['tarn-sync-cursors', 'tarn-blob-cache'];

/**
 * Best-effort IDB database deletion. Resolves on success, error, or
 * block (so callers can't hang). Silent — failures are non-fatal.
 *
 * @param {string} name
 * @param {{ idb?: IDBFactory }} [opts] — injectable for tests
 * @returns {Promise<void>}
 */
export function deleteIndexedDb(name, { idb = globalThis.indexedDB } = {}) {
  return new Promise((resolve) => {
    try {
      const req = idb.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
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
