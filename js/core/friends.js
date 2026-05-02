// friends.js — Bookish-facing facade over the schema-first Tarn SDK.
//
// Each function here is a thin pass-through to `tarn.connections.*` or
// `tarn.books.*`, plus the small amount of Bookish-specific UI state that
// doesn't belong in the SDK:
//
//   - sessionStorage-bridged pending invite (for surviving the auth
//     redirect on /invite/:token_id), and the URL-parsing helper that
//     extracts the two-secret invite token from the path + hash.
//
//   - The friend-library match cache: a work_key → [{connection, book}]
//     index, populated from `tarn.books.listShared()` per visible
//     connection. Drives Library card pips, omnibox pips, and the
//     friend-book-detail modal. Cache invalidates on connection changes.
//
// The previous version of this module carried two large workarounds that
// the new SDK eliminates entirely:
//
//   - A `crypto.subtle.wrapKey` monkey-patch (`_captureCekDuringCall`)
//     that reached inside the legacy SDK to capture the per-content CEK
//     so we could fan out a publish to friends. The new SDK exposes
//     `tarn.books.share()` / `tarn.books.shareWithAll()` which manage
//     the shareKey internally — no interception needed.
//
//   - A hand-implemented v3-blob-format decryptor (`_decryptSharedBlob*`,
//     magic-byte constants, AES-GCM byte slicing) so we could read a
//     friend's shared blobs without the legacy SDK helping. The new SDK
//     exposes `tarn.books.listShared(connection)` which returns the
//     fully-decoded records.
//
// Net effect: ~200 lines removed; the module is now a facade.

import * as tarnService from './tarn_service.js';

// localStorage key for the recipient-side pending-label map.
// Shape: { [share_pub]: { label: string, set_at: number } }
const PENDING_LABELS_KEY = 'bookish.friends.pendingLabels';

// sessionStorage key for invite parameters held across the signup redirect.
// Shape: { token_id: string, payload_key: string, captured_at: number }
const PENDING_INVITE_KEY = 'bookish.friends.pendingInvite';

// ============ Pending-invite state (signup redirect bridge) ============

/**
 * Stash invite parameters in sessionStorage so they survive a signup or
 * sign-in redirect. The recipient-side accept-modal flow reads this back
 * after auth completes.
 */
export function stashPendingInvite(invite) {
  if (!invite || !invite.token_id || !invite.payload_key) return;
  try {
    sessionStorage.setItem(
      PENDING_INVITE_KEY,
      JSON.stringify({
        token_id: invite.token_id,
        payload_key: invite.payload_key,
        captured_at: Date.now(),
      }),
    );
  } catch {
    // sessionStorage can throw in private mode or if the quota is hit;
    // the caller will see no stashed invite, which is acceptable.
  }
}

export function readPendingInvite() {
  let raw;
  try { raw = sessionStorage.getItem(PENDING_INVITE_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token_id !== 'string' || typeof parsed.payload_key !== 'string') {
      return null;
    }
    return { token_id: parsed.token_id, payload_key: parsed.payload_key };
  } catch {
    return null;
  }
}

export function clearPendingInvite() {
  try { sessionStorage.removeItem(PENDING_INVITE_KEY); } catch { /* ignore */ }
}

// ============ URL parsing ============

/**
 * Extract `{ token_id, payload_key }` from an invite URL. Returns null if
 * the URL doesn't match the expected `/invite/<token_id>#<payload_key>`
 * shape.
 */
export function parseInviteUrl(input) {
  let pathname, hash;
  if (input == null) {
    if (typeof window === 'undefined' || !window.location) return null;
    pathname = window.location.pathname;
    hash = window.location.hash;
  } else if (typeof input === 'string') {
    let url;
    try {
      url = new URL(input, 'https://placeholder.invalid');
    } catch {
      return null;
    }
    pathname = url.pathname;
    hash = url.hash;
  } else if (input instanceof URL) {
    pathname = input.pathname;
    hash = input.hash;
  } else if (input && typeof input.pathname === 'string') {
    pathname = input.pathname;
    hash = input.hash || '';
  } else {
    return null;
  }

  const match = pathname.match(/^\/invite\/([^/?#]+)\/?$/);
  if (!match) return null;
  const tokenId = decodeURIComponent(match[1]);
  if (!tokenId) return null;

  const payloadKey = (hash || '').replace(/^#/, '');
  if (!payloadKey) return null;

  return { token_id: tokenId, payload_key: payloadKey };
}

// ============ Pending-label storage (recipient side) ============
//
// The recipient's chosen label can't be set on the SDK redeemInvite call
// because the connection only materializes after the inviter's session
// auto-accepts and the recipient polls listIncomingRequests. We stash the
// label keyed by inviter share_pub and apply it when listConnections
// surfaces the matching entry.

function readPendingLabelMap() {
  try {
    const raw = localStorage.getItem(PENDING_LABELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingLabelMap(map) {
  try {
    localStorage.setItem(PENDING_LABELS_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function rememberPendingLabel(sharePub, label) {
  if (!sharePub || typeof sharePub !== 'string') return;
  const trimmed = (label || '').trim();
  if (!trimmed) return;
  const map = readPendingLabelMap();
  map[sharePub] = { label: trimmed, set_at: Date.now() };
  writePendingLabelMap(map);
}

/**
 * Apply any pending labels to connections that have materialized.
 * Idempotent — connections without a pending label are skipped, and the
 * pending entry is dropped once applied.
 */
export async function applyPendingLabels() {
  const map = readPendingLabelMap();
  const sharePubs = Object.keys(map);
  if (sharePubs.length === 0) return { applied: 0 };

  if (!tarnService.isLoggedIn()) return { applied: 0 };
  let tarn;
  try { tarn = await tarnService.getClient(); } catch { return { applied: 0 }; }

  let connections;
  try {
    connections = await tarn.connections.list();
  } catch {
    return { applied: 0 };
  }

  let applied = 0;
  let mutated = false;
  for (const sharePub of sharePubs) {
    const entry = map[sharePub];
    const conn = connections.find(c => c.share_pub === sharePub);
    if (!conn) continue;
    try {
      await tarn.connections.setLabel(conn, entry.label);
      applied++;
    } catch (err) {
      console.warn('[Bookish:Friends] setLabel failed:', err.message);
      continue;
    }
    delete map[sharePub];
    mutated = true;
  }

  if (mutated) writePendingLabelMap(map);
  return { applied };
}

// ============ Invite generation (sender) ============

/**
 * Generate a single-use invite link.
 *
 * @param {{ displayName?: string, expiryDays?: number }} [opts]
 * @returns {Promise<{ token_id: string, invite_url: string, expires_at: number, parsed: { token_id: string, payload_key: string } | null }>}
 */
export async function generateInvite(opts = {}) {
  const tarn = await tarnService.getClient();
  const created = await tarn.connections.createInvite({
    display_name: opts.displayName ?? '',
    expiry_days: opts.expiryDays ?? 7,
  });
  const parsed = parseInviteUrl(created.invite_url);
  return { ...created, parsed };
}

// ============ Invite preview (recipient, non-consuming) ============

/**
 * Non-consuming preview of an invite. Returns null on expired / used /
 * not-found / wrong-key — does not throw on the recoverable failure modes.
 */
export async function previewInvite({ token_id, payload_key }) {
  const tarn = await tarnService.getClient();
  return await tarn.connections.previewInvite(token_id, payload_key);
}

// ============ Invite accept (recipient) ============

/**
 * Redeem an invite and remember the recipient's chosen label so it can be
 * applied to the connection when it materializes. The connection only
 * appears in `connections.list()` after the inviter's session auto-accepts;
 * label propagation happens inside `applyPendingLabels`.
 *
 * @param {{ token_id: string, payload_key: string, label: string }} args
 * @returns {Promise<{ requestNonce: string, inviterSharePub: string }>}
 */
export async function acceptInvite({ token_id, payload_key, label }) {
  const tarn = await tarnService.getClient();
  const result = await tarn.connections.redeemInvite(token_id, payload_key);
  // The redeem result names the inviter's share_pub as `recipient_share_pub`
  // because the inbox-publish primitive addresses the inviter as
  // "recipient" of the inbox blob. Stash the chosen label against that
  // share_pub so applyPendingLabels finds it later.
  const inviterSharePub = result.recipient_share_pub;
  if (label && inviterSharePub) {
    rememberPendingLabel(inviterSharePub, label);
  }
  // Best-effort: try to apply now in case the connection already exists.
  try { await applyPendingLabels(); } catch { /* ignore */ }
  return { requestNonce: result.request_nonce, inviterSharePub };
}

// ============ Read-side surfaces ============

/**
 * List the user's connections. Opportunistically applies any pending
 * labels (cheap no-op if none).
 */
export async function listConnections() {
  if (!tarnService.isLoggedIn()) return [];
  try { await applyPendingLabels(); } catch { /* ignore */ }
  const tarn = await tarnService.getClient();
  return await tarn.connections.list();
}

/**
 * List the user's outstanding issued invites (sender side).
 */
export async function listIssuedInvites() {
  if (!tarnService.isLoggedIn()) return [];
  const tarn = await tarnService.getClient();
  return await tarn.connections.listIssuedInvites();
}

/**
 * Revoke an issued invite.
 */
export async function revokeInvite(token_id) {
  const tarn = await tarnService.getClient();
  return await tarn.connections.revokeIssuedInvite(token_id);
}

// ============ Mute / Remove ============

function emitConnectionsChanged() {
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bookish:connections-changed'));
    }
  } catch { /* ignore */ }
}

/**
 * Return the set of share_pubs currently muted, as a `Set<string>`.
 * Fail-open: returns an empty set on any error.
 */
export async function getMutedSharePubs() {
  if (!tarnService.isLoggedIn()) return new Set();
  let tarn;
  try { tarn = await tarnService.getClient(); } catch { return new Set(); }
  try {
    const conns = await tarn.connections.list();
    const out = new Set();
    for (const c of conns) {
      if (c.muted) out.add(c.share_pub);
    }
    return out;
  } catch (err) {
    console.warn('[Bookish:Friends] listConnections failed (mute scan):', err.message);
    return new Set();
  }
}

/**
 * Best-effort isMuted check for a single connection. Fail-open.
 */
export async function isMuted(connection) {
  if (!connection || !connection.share_pub) return false;
  if (!tarnService.isLoggedIn()) return false;
  let tarn;
  try { tarn = await tarnService.getClient(); } catch { return false; }
  try {
    return await tarn.connections.isMuted(connection);
  } catch {
    return false;
  }
}

export async function muteConnection(connection) {
  if (!connection || !connection.share_pub) {
    throw new Error('muteConnection: connection.share_pub is required');
  }
  const tarn = await tarnService.getClient();
  await tarn.connections.mute(connection);
  invalidateFriendLibraryCache();
  emitConnectionsChanged();
}

export async function unmuteConnection(connection) {
  if (!connection || !connection.share_pub) {
    throw new Error('unmuteConnection: connection.share_pub is required');
  }
  const tarn = await tarnService.getClient();
  await tarn.connections.unmute(connection);
  invalidateFriendLibraryCache();
  emitConnectionsChanged();
}

export async function removeConnection(connection) {
  if (!connection || !connection.share_pub) {
    throw new Error('removeConnection: connection.share_pub is required');
  }
  const tarn = await tarnService.getClient();
  await tarn.connections.remove(connection);
  invalidateFriendLibraryCache();
  emitConnectionsChanged();
}

/**
 * Trigger a poll of incoming connection requests. Used by the recipient
 * after `acceptInvite` — the inviter's auto-accept eventually lands in our
 * inbox; calling listIncomingRequests processes it and adds the new
 * connection. Safe to call repeatedly.
 */
export async function pollForConnectionUpdates() {
  if (!tarnService.isLoggedIn()) return;
  let tarn;
  try { tarn = await tarnService.getClient(); } catch { return; }
  try { await tarn.connections.listIncomingRequests(); } catch (err) {
    console.warn('[Bookish:Friends] listIncomingRequests failed:', err.message);
  }
  try { await applyPendingLabels(); } catch { /* ignore */ }
  emitConnectionsChanged();
}

// ============ Friend's-shelf read flow ============

/**
 * Fetch a friend's published library via the SDK's typed `listShared` on
 * the books collection. Returns the records directly — the SDK handles
 * blob fetch + decrypt internally.
 *
 * Defense-in-depth: filter out anything marked `is_private: true` even
 * though private books should never appear in a friend's share-log
 * (the publish gate filters at the source).
 *
 * @param {{ share_pub: string, signing_pub: string, label?: string|null }} connection
 * @returns {Promise<Array<Object>>}
 */
export async function fetchFriendLibrary(connection /* opts unused (legacy fetchImpl) */) {
  if (!connection || !connection.share_pub || !connection.signing_pub) {
    throw new Error('fetchFriendLibrary: connection.share_pub and signing_pub are required');
  }
  const tarn = await tarnService.getClient();
  const records = await tarn.books.listShared(connection);
  return filterOutPrivate(records || []);
}

// ============ Friend-library matching cache ============
//
// Library card pips and omnibox pips need a fast lookup: "for this work_key,
// which friends have it on Reading or Read?" We cache an inverted index
// keyed by work_key, primed from each non-muted friend's listShared() result.
//
// Cache shape: Map<workKey, Array<{ connection, book }>>
// - Built once per refresh.
// - Friends with the work in WTR are excluded.
// - Books without a work_key contribute nothing (strict equality only).
// - Muted connections are excluded.
// - Invalidates on connection changes.

let _matchCacheDeps = null;
let _matchCache = null;
let _primingPromise = null;
let _cacheGeneration = 0;

export function filterPippableBooks(books) {
  if (!Array.isArray(books)) return [];
  const out = [];
  for (const b of books) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.work_key !== 'string' || !b.work_key) continue;
    if (b.readingStatus === 'want_to_read') continue;
    out.push(b);
  }
  return out;
}

export async function primeFriendLibraryCache(opts = {}) {
  if (_primingPromise) return _primingPromise;
  if (!opts.force && _matchCache !== null) {
    return { generation: _cacheGeneration, friendCount: 0, workKeyCount: _matchCache.size };
  }

  const promise = (async () => {
    if (!tarnService.isLoggedIn()) {
      _matchCache = new Map();
      return { generation: _cacheGeneration, friendCount: 0, workKeyCount: 0 };
    }

    const listFn = (_matchCacheDeps && _matchCacheDeps.listConnections) || listConnections;
    const fetchFn = (_matchCacheDeps && _matchCacheDeps.fetchFriendLibrary) || fetchFriendLibrary;

    let connections = [];
    try {
      connections = await listFn();
    } catch {
      _matchCache = new Map();
      return { generation: _cacheGeneration, friendCount: 0, workKeyCount: 0 };
    }
    if (!connections.length) {
      _matchCache = new Map();
      _cacheGeneration++;
      _emitLibrariesRefreshed();
      return { generation: _cacheGeneration, friendCount: 0, workKeyCount: 0 };
    }

    // Filter muted up front so we don't burn fetches on them. Connection
    // objects from tarn.connections.list() now carry `muted` directly.
    const visible = connections.filter(c => c && c.share_pub && !c.muted);

    const results = await Promise.allSettled(visible.map(conn => fetchFn(conn)));

    const next = new Map();
    results.forEach((r, idx) => {
      if (r.status !== 'fulfilled') {
        console.warn(
          '[Bookish:Friends] primeFriendLibraryCache: listShared failed for',
          visible[idx].share_pub?.slice(0, 8),
          r.reason?.message,
        );
        return;
      }
      const conn = visible[idx];
      const books = filterPippableBooks(r.value || []);
      for (const book of books) {
        const list = next.get(book.work_key);
        if (list) {
          if (!list.some(entry => entry.connection.share_pub === conn.share_pub)) {
            list.push({ connection: conn, book });
          }
        } else {
          next.set(book.work_key, [{ connection: conn, book }]);
        }
      }
    });

    _matchCache = next;
    _cacheGeneration++;
    _emitLibrariesRefreshed();
    return {
      generation: _cacheGeneration,
      friendCount: visible.length,
      workKeyCount: next.size,
    };
  })();

  _primingPromise = promise;
  try {
    return await promise;
  } finally {
    _primingPromise = null;
  }
}

function _emitLibrariesRefreshed() {
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bookish:friend-libraries-refreshed', {
        detail: { generation: _cacheGeneration },
      }));
    }
  } catch { /* ignore */ }
}

export function invalidateFriendLibraryCache() {
  _matchCache = null;
}

export function getMatchingFriends(workKey) {
  return getMatchingFriendBookEntries(workKey).map(entry => entry.connection);
}

export function getMatchingFriendBookEntries(workKey) {
  if (!workKey || typeof workKey !== 'string') return [];
  if (_matchCache === null) {
    primeFriendLibraryCache().catch(() => { /* swallow */ });
    return [];
  }
  const list = _matchCache.get(workKey);
  if (!list || list.length === 0) return [];
  return [...list].sort((a, b) => {
    const ea = a.connection.established_at || 0;
    const eb = b.connection.established_at || 0;
    if (ea !== eb) return eb - ea;
    return (a.connection.share_pub || '').localeCompare(b.connection.share_pub || '');
  });
}

export function _getMatchCacheGenerationForTest() { return _cacheGeneration; }

export function _resetMatchCacheForTest() {
  _matchCache = null;
  _primingPromise = null;
  _cacheGeneration = 0;
  _matchCacheDeps = null;
}

export function _setMatchCacheDepsForTest(deps) {
  _matchCacheDeps = deps;
}

// ============ Defense-in-depth: filter is_private ============

export function filterOutPrivate(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(e => !e || e.is_private !== true);
}

// Storage key exports for tests + cleanup paths.
export const STORAGE_KEYS = {
  PENDING_LABELS: PENDING_LABELS_KEY,
  PENDING_INVITE: PENDING_INVITE_KEY,
};
