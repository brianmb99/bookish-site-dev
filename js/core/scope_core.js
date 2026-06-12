// scope_core.js — Pure account-scope logic for the local books cache (#231).
//
// The IndexedDB books cache (`bookish` DB, public/js/cache.js) holds
// already-DECRYPTED book entries. Before #231 it had no notion of which
// account an entry belonged to, so on a shared device one user's books
// could be rendered for the next user. Every cached entry now carries a
// `scope` field:
//
//   - a Tarn dataLookupKey (dlk) — the entry belongs to that account;
//   - 'guest'                   — the entry was created while logged out
//                                 (guest mode, see #113: logged-out books
//                                 intentionally persist in IndexedDB and
//                                 are the user's ONLY copy);
//   - missing/undefined         — legacy entry written before #231. These
//                                 are tagged once at boot (see
//                                 migrateUnscopedEntries in cache.js) and
//                                 must NEVER be deleted just for lacking a
//                                 scope.
//
// This module is pure decision logic (no IndexedDB, no globals) so it can
// be unit-tested directly — mirrors the cache.js / cache_core.js split.

/** Scope value for entries created while logged out (guest mode, #113). */
export const GUEST_SCOPE = 'guest';

/**
 * Fallback scope for a logged-in session whose dataLookupKey is unknown.
 * Should not happen in practice (register/login/passkey-auth all persist
 * the dlk; see tarn_service.js), but if it ever does we must not fall
 * back to GUEST_SCOPE — account data would then leak into the logged-out
 * view. Two different accounts could both map to this sentinel, so
 * callers treat an unknown scope as ALWAYS being an account switch
 * (conservative: full clear + resync).
 */
export const UNKNOWN_ACCOUNT_SCOPE = 'account:unknown';

/**
 * Scope for a logged-in session: the dlk, or the conservative sentinel
 * when the dlk could not be resolved.
 * @param {string|null|undefined} dlk
 * @returns {string}
 */
export function resolveAccountScope(dlk) {
  return dlk || UNKNOWN_ACCOUNT_SCOPE;
}

/**
 * Scope to activate at boot, after tarnService.init() has resolved.
 * @param {{ isLoggedIn: boolean, dlk?: string|null }} opts
 * @returns {string}
 */
export function resolveBootScope({ isLoggedIn, dlk }) {
  return isLoggedIn ? resolveAccountScope(dlk) : GUEST_SCOPE;
}

/**
 * Read-path filter: should this cached entry be visible under the given
 * active scope?
 *
 * Entries with NO scope are treated as belonging to the active scope.
 * Rationale: unscoped entries only exist transiently (before the one-time
 * boot migration stamps them) or if that migration failed. Hiding them
 * would reproduce the #230 symptom ("library shows nothing") for the
 * legitimate owner; showing them matches pre-#231 behavior, i.e. this is
 * graceful degradation, never a regression.
 *
 * @param {Object} entry
 * @param {string} activeScope
 * @returns {boolean}
 */
export function matchesActiveScope(entry, activeScope) {
  return entry?.scope == null || entry.scope === activeScope;
}

/**
 * Whether an entry has ever been confirmed against the remote. Mirrors
 * the heuristics in book_repository.js (isRemoteBackedEntry) plus the
 * tombstone state (only remote-backed entries are ever tombstoned —
 * local-only deletes are hard deletes, see BookRepository.delete()).
 * @param {Object} entry
 * @returns {boolean}
 */
export function isRemoteBackedEntry(entry) {
  return entry?.seenRemote === true
    || entry?.remoteBacked === true
    || entry?.status === 'confirmed'
    || entry?.status === 'tombstoned';
}

/**
 * Guest → account adoption (sign-in / sign-up): should this entry be
 * re-scoped from 'guest' to the signing-in account?
 *
 * Only locally-created, never-synced guest entries qualify — those are
 * the books a guest added before creating/signing in to an account, and
 * the queued 'create' ops in the ops store will upload them on the first
 * sync (BookRepository.replayPending()).
 *
 * Remote-backed entries that carry the 'guest' scope can only be residue
 * of a PREVIOUS account tagged by the one-time migration (a guest can
 * never sync to the remote), so adopting them would hand one user's books
 * to another account. They stay 'guest': invisible while logged in,
 * untouched on disk per the #113 never-wipe-guest-data rule.
 *
 * @param {Object} entry
 * @returns {boolean}
 */
export function isAdoptableGuestEntry(entry) {
  return entry?.scope === GUEST_SCOPE && !isRemoteBackedEntry(entry);
}

/**
 * Privacy prune (sign-in as account X): should this entry be deleted from
 * disk? True only for entries scoped to some OTHER account — bounds cache
 * growth and removes other users' decrypted books from the device.
 *
 * Guest entries are always kept (#113: they may be the user's only copy).
 * Unscoped (legacy) entries are always kept — entries must never be
 * deleted based on a missing scope alone.
 *
 * @param {Object} entry
 * @param {string[]} keepScopes — scopes to retain (the active account's
 *   scope and GUEST_SCOPE)
 * @returns {boolean}
 */
export function shouldPruneEntry(entry, keepScopes) {
  return entry?.scope != null && !keepScopes.includes(entry.scope);
}
