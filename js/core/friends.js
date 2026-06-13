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
// Shape: { token_id: string, payload_key: string, display_name?: string, captured_at: number }
const PENDING_INVITE_KEY = 'bookish.friends.pendingInvite';

// ============ Pending-invite state (signup redirect bridge) ============

/**
 * Stash invite parameters in sessionStorage so they survive a signup or
 * sign-in redirect. The recipient-side accept-modal flow reads this back
 * after auth completes.
 */
export function stashPendingInvite(invite) {
  if (!invite || !invite.token_id || !invite.payload_key) return;
  const displayName = normalizeInviteDisplayName(invite.display_name);
  try {
    sessionStorage.setItem(
      PENDING_INVITE_KEY,
      JSON.stringify({
        token_id: invite.token_id,
        payload_key: invite.payload_key,
        ...(displayName ? { display_name: displayName } : {}),
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
    const displayName = normalizeInviteDisplayName(parsed.display_name);
    return {
      token_id: parsed.token_id,
      payload_key: parsed.payload_key,
      ...(displayName ? { display_name: displayName } : {}),
    };
  } catch {
    return null;
  }
}

export function clearPendingInvite() {
  try { sessionStorage.removeItem(PENDING_INVITE_KEY); } catch { /* ignore */ }
}

// ============ URL parsing ============

/**
 * Extract `{ token_id, payload_key, display_name? }` from an invite URL.
 * Returns null if the URL doesn't match the expected
 * `/invite/<token_id>#<payload_key>` shape. New Bookish links can append
 * `&from=<display-name>` inside the fragment so the name stays client-side
 * (not sent to GitHub Pages / Tarn).
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

  const fragment = (hash || '').replace(/^#/, '');
  const payloadKey = fragment.split('&')[0] || '';
  if (!payloadKey) return null;

  const displayName = readInviteDisplayNameFromFragment(fragment);
  return {
    token_id: tokenId,
    payload_key: payloadKey,
    ...(displayName ? { display_name: displayName } : {}),
  };
}

function normalizeInviteDisplayName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 64);
}

function readInviteDisplayNameFromFragment(fragment) {
  const amp = fragment.indexOf('&');
  if (amp === -1) return '';
  try {
    const params = new URLSearchParams(fragment.slice(amp + 1));
    return normalizeInviteDisplayName(params.get('from') || '');
  } catch {
    return '';
  }
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
  const displayName = normalizeInviteDisplayName(opts.displayName ?? '');
  // The recipient-facing name rides INSIDE the encrypted invite payload
  // (SDK `recipient_metadata`) and comes back decrypted from
  // previewInvite() — integrity-bound by the payload's GCM tag, unlike the
  // old `&from=` fragment suffix a link-forwarder could edit. New links
  // therefore carry no `from=`; parseInviteUrl keeps fragment parsing as a
  // fallback for links minted before this change.
  const created = await tarn.connections.createInvite({
    label: displayName,
    expiry_days: opts.expiryDays ?? 7,
    ...(displayName ? { recipient_metadata: { display_name: displayName } } : {}),
  });
  const inviteUrl = created.invite_url;
  const parsed = parseInviteUrl(inviteUrl);
  // The handshake completes only if our session polls the inbox after the
  // recipient redeems — start the heartbeat (fast burst now, steady
  // background cadence via the sync loop for the long tail).
  noteHandshakeInterest();
  startConnectionBurst();
  return { ...created, invite_url: inviteUrl, parsed };
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
  // Our connection materializes only after the inviter's session
  // auto-accepts AND we poll the accept back — start the heartbeat.
  noteHandshakeInterest();
  startConnectionBurst();
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

// ============ Connection polling (handshake heartbeat) ============
//
// The Tarn handshake is poll-driven on BOTH sides: the inviter's session
// auto-accepts an incoming redeem only inside `listIncomingRequests()`, and
// the recipient's connection materializes only when a later
// `listIncomingRequests()` processes the accept. Without a heartbeat the
// handshake never completes — neither side sees the friend, ever.
//
// Cost model (drives every constant below): each poll fetches
// (windows + 30) inbox tags against a 1800-fetches/hour/IP API budget —
// the accepts scan is pinned at 30 windows SDK-side regardless of the
// `windows` option. So a shallow poll costs ~32 fetches and the cadences
// here keep worst-case usage near ~600/hr even with two clients (inviter +
// recipient under test) sharing one IP.
//
//   - Burst: 5s ticks for 30s, then 15s ticks to 3min — started on
//     createInvite / redeemInvite, stops early once the connection lands.
//     Gives the "friend appears in seconds" UX when both parties are online.
//   - Steady state (rides the sync loop): every ~4min while a handshake is
//     plausibly pending (interest flag, 24h TTL), every ~15min as baseline.
//   - First poll per session scans the full 30-window depth to catch
//     handshakes that progressed while we were offline; the rest are shallow.

const HANDSHAKE_INTEREST_KEY = 'bookish.friends.handshakeInterestUntil';
const HANDSHAKE_INTEREST_TTL_MS = 24 * 60 * 60 * 1000;
const POLL_WINDOWS_SHALLOW = 2;          // request scan depth; +30 fixed for accepts
const BURST_FAST_TICK_MS = 5000;
const BURST_FAST_PHASE_MS = 30000;
const BURST_SLOW_TICK_MS = 15000;
const BURST_TOTAL_MS = 3 * 60 * 1000;
const STEADY_PENDING_MS = 4 * 60 * 1000;
const STEADY_BASELINE_MS = 15 * 60 * 1000;

let _pollInFlight = null;
let _lastPollAt = 0;
let _deepPolledThisSession = false;
let _burstTimer = null;
let _burstStartedAt = 0;
let _burstBaselineCount = -1;

/** Mark that a handshake is plausibly in flight (we issued or redeemed an
 * invite recently), so the steady-state cadence tightens. Persisted so the
 * faster cadence survives a reload while the other side catches up. */
function noteHandshakeInterest() {
  try {
    localStorage.setItem(HANDSHAKE_INTEREST_KEY, String(Date.now() + HANDSHAKE_INTEREST_TTL_MS));
  } catch { /* ignore */ }
}

function handshakeInterestActive() {
  try {
    const until = Number(localStorage.getItem(HANDSHAKE_INTEREST_KEY));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

/**
 * Trigger a poll of incoming connection requests. Processes both directions
 * of the handshake: surfaces + auto-accepts incoming redeems (inviter side)
 * and ingests incoming accepts (recipient side). Safe to call repeatedly;
 * concurrent calls coalesce onto the in-flight poll.
 *
 * @param {{ windows?: number }} [opts] - request-scan depth in day-windows;
 *   omit for the SDK's full 30-window default.
 */
export async function pollForConnectionUpdates(opts = {}) {
  if (!tarnService.isLoggedIn()) return;
  if (_pollInFlight) return _pollInFlight;
  _pollInFlight = (async () => {
    let tarn;
    try { tarn = await tarnService.getClient(); } catch { return; }
    _lastPollAt = Date.now();
    const sdkOpts = Number.isInteger(opts.windows) && opts.windows > 0
      ? { windows: opts.windows }
      : {};
    try { await tarn.connections.listIncomingRequests(sdkOpts); } catch (err) {
      console.warn('[Bookish:Friends] listIncomingRequests failed:', err.message);
    }
    try { await applyPendingLabels(); } catch { /* ignore */ }
    emitConnectionsChanged();
  })();
  try {
    await _pollInFlight;
  } finally {
    _pollInFlight = null;
  }
}

/**
 * Start (or extend) the post-invite-activity polling burst. Idempotent —
 * calling while a burst is running just pushes the deadline out. Stops
 * early once the connection count grows past the burst-start baseline
 * (handshake completed), on logout, or at the 3-minute deadline.
 */
export function startConnectionBurst() {
  _burstStartedAt = Date.now();
  // Baseline for early-stop. Best-effort — if it can't be read, the burst
  // simply runs to its deadline.
  listConnections()
    .then(conns => { _burstBaselineCount = conns.length; })
    .catch(() => { _burstBaselineCount = -1; });
  if (_burstTimer) return;

  const tick = async () => {
    _burstTimer = null;
    if (!tarnService.isLoggedIn()) return;
    const elapsed = Date.now() - _burstStartedAt;
    if (elapsed > BURST_TOTAL_MS) return;
    try {
      await pollForConnectionUpdates({ windows: POLL_WINDOWS_SHALLOW });
      if (_burstBaselineCount >= 0) {
        const count = (await listConnections()).length;
        if (count > _burstBaselineCount) return; // handshake landed — done
      }
    } catch { /* keep ticking */ }
    const interval = (Date.now() - _burstStartedAt) < BURST_FAST_PHASE_MS
      ? BURST_FAST_TICK_MS
      : BURST_SLOW_TICK_MS;
    _burstTimer = setTimeout(tick, interval);
  };
  _burstTimer = setTimeout(tick, BURST_FAST_TICK_MS);
}

/**
 * Steady-state heartbeat — called by the sync manager on every sync cycle;
 * decides internally whether a poll is actually due so the caller doesn't
 * carry any cadence logic. First call per session polls at full depth.
 */
export async function maybePollConnectionsOnSyncCycle() {
  if (!tarnService.isLoggedIn()) return;
  const now = Date.now();
  if (!_deepPolledThisSession) {
    _deepPolledThisSession = true;
    await pollForConnectionUpdates();
    return;
  }
  const due = handshakeInterestActive() ? STEADY_PENDING_MS : STEADY_BASELINE_MS;
  if (now - _lastPollAt < due) return;
  await pollForConnectionUpdates({ windows: POLL_WINDOWS_SHALLOW });
}

/** Test hook: reset module-level polling state between unit tests. */
export function _resetConnectionPollingForTests() {
  if (_burstTimer) { clearTimeout(_burstTimer); _burstTimer = null; }
  _pollInFlight = null;
  _lastPollAt = 0;
  _deepPolledThisSession = false;
  _burstStartedAt = 0;
  _burstBaselineCount = -1;
  try { localStorage.removeItem(HANDSHAKE_INTEREST_KEY); } catch { /* ignore */ }
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
