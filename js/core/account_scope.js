// account_scope.js — Sign-in cache hygiene + the per-device last-account
// marker (#231).
//
// How the active scope is threaded (no circular imports):
//
//   cache.js  (window.bookishCache) — owns the IndexedDB stores and an
//             in-module `activeScope` set via setActiveScope(). It imports
//             only the pure decision functions from scope_core.js.
//   app.js    (boot) — after tarnService.init() resolves, computes the
//             boot scope (restored session's dlk, else 'guest'), calls
//             bookishCache.setActiveScope(), and runs the one-time
//             migration that tags legacy unscoped entries.
//   account_ui.js (sign-in / sign-up / logout) — calls
//             applySignInScopeHygiene() below on every successful
//             authentication BEFORE the first sync, and resets the scope
//             to 'guest' on logout.
//
// This module never imports cache.js (it receives the cache as a
// parameter, defaulting to window.bookishCache), so cache.js itself stays
// import-cycle-free.

import { GUEST_SCOPE, resolveAccountScope } from './scope_core.js';
import { deleteTarnSdkLocalDbs } from './local_db_reset.js';

/**
 * localStorage key recording the dlk of the last account that synced on
 * this device. Set on every successful sign-in / sign-up (and backfilled
 * at boot for already-signed-in users). Cleared on explicit logout
 * (logout wipes all local book state, so "last synced account" is no
 * longer meaningful). Absent ⇒ treat the next sign-in as an account
 * switch (conservative: wipe SDK cursors, full resync).
 */
export const LAST_DLK_KEY = 'bookish.lastDlk';

export function getLastSyncedDlk(storage = globalThis.localStorage) {
  try { return storage.getItem(LAST_DLK_KEY); } catch { return null; }
}

export function setLastSyncedDlk(dlk, storage = globalThis.localStorage) {
  try { storage.setItem(LAST_DLK_KEY, dlk); } catch { /* non-fatal */ }
}

export function clearLastSyncedDlk(storage = globalThis.localStorage) {
  try { storage.removeItem(LAST_DLK_KEY); } catch { /* non-fatal */ }
}

/**
 * Run after EVERY successful explicit authentication (password sign-in,
 * passkey sign-in, account creation) and BEFORE the first sync starts.
 *
 * Cases handled (dlk = the just-authenticated account's dataLookupKey,
 * marker = LAST_DLK_KEY):
 *
 *   - Fresh device (no marker, empty cache): treated as a switch — the
 *     SDK cursor/blob DBs are deleted (a no-op when absent), the prune
 *     finds nothing, the marker is established. First sync is a full
 *     fetch, which is correct on a fresh device.
 *   - Same account (marker === dlk): warm path. Cursors and cache are
 *     kept so the first sync is a cheap delta. Prune + guest adoption
 *     still run (both are no-ops unless something is out of place).
 *   - Different account (marker set, ≠ dlk): the SDK cursor + blob DBs
 *     are deleted and entries scoped to OTHER accounts are pruned from
 *     the books cache. Deleting the cursors whenever foreign scopes are
 *     pruned preserves the #230 invariant — a cursor must never outlive
 *     the cached entries it accounts for, otherwise the next sign-in of
 *     the pruned account would delta-sync into an empty cache.
 *   - Marker missing but cache non-empty (one-time migration boundary, or
 *     any unknown state): treated as a switch, same as fresh device. The
 *     prune only ever removes entries scoped to other accounts — guest
 *     entries and the (rare) legacy unscoped entries are always kept.
 *   - dlk unresolvable (should not happen): treated as a switch every
 *     time, and the marker is cleared so the NEXT sign-in is also treated
 *     as a switch. Writes land under UNKNOWN_ACCOUNT_SCOPE, which any
 *     later identified sign-in prunes.
 *
 * Guest adoption: locally-created, never-synced guest entries are
 * re-scoped to the account here, so the books a guest added remain
 * visible immediately after signing in and survive even if the first
 * sync fails (their queued 'create' ops upload them when sync succeeds).
 *
 * @param {{
 *   dlk: string|null|undefined,
 *   cache?: Object,                       — defaults to window.bookishCache
 *   wipeSdkDbs?: () => Promise<void>,     — injectable for tests
 *   storage?: Storage,                    — injectable for tests
 * }} opts
 * @returns {Promise<{ scope: string, accountSwitched: boolean }>}
 */
export async function applySignInScopeHygiene({
  dlk,
  cache = globalThis.window?.bookishCache,
  wipeSdkDbs = deleteTarnSdkLocalDbs,
  storage = globalThis.localStorage,
} = {}) {
  const scope = resolveAccountScope(dlk);
  const lastDlk = getLastSyncedDlk(storage);
  const accountSwitched = !dlk || !lastDlk || lastDlk !== dlk;

  // Scope first: any write that races the rest of this function must
  // already be stamped with the new account's scope.
  cache?.setActiveScope?.(scope);

  if (accountSwitched) {
    // Cursor + blob cache must not survive an account switch (#230/#231).
    await wipeSdkDbs();
  }

  // Privacy prune: drop entries scoped to OTHER accounts (never guest,
  // never unscoped). Then adopt the guest's local-only books into this
  // account so they render immediately and replay-upload on first sync.
  await cache?.pruneOtherScopes?.([scope, GUEST_SCOPE]);
  await cache?.adoptGuestEntries?.(scope);

  if (dlk) setLastSyncedDlk(dlk, storage);
  else clearLastSyncedDlk(storage);

  return { scope, accountSwitched };
}

export { GUEST_SCOPE };
