// friends.js — Bookish-facing wrapper over the Tarn sharing SDK.
//
// Section 8 invite-token primitive lives entirely in tarn.client; this module
// provides a smaller, Bookish-shaped surface that the UI components (invite
// modal, accept-invite modal, account-screen entry points) call into.
//
// Initialization is lazy. The wrapper is created on first call from any
// Friends-feature code path so it doesn't block app startup for users who
// never touch Friends. tarn_service.getClient() requires login; callers must
// gate Friends features on tarnService.isLoggedIn() or be ready to handle the
// "Not logged in" throw.
//
// The recipient-side label flow is the trickiest piece. The Tarn SDK accepts
// a `label` only on the inviter's side (auto-applied during the auto-accept
// path with the inviter's own display_name — which seeds an unhelpful label
// for the inviter's view of the friend; users can relabel in their
// Connections list). The redeemer (recipient) chooses what to call the
// inviter, but `redeemInviteToken` does not take a label argument: the new
// connection materializes only after the inviter's accept lands and the
// recipient's `listIncomingRequests` / poll picks it up. To bridge that gap
// we stash the recipient's chosen label in localStorage, keyed by the
// inviter's share_pub (returned by `redeemInviteToken` as
// `recipientSharePubBase64Url` — confusingly named in the SDK), and apply it
// the moment the matching connection appears in `listConnections`. See the
// `applyPendingLabels` helper below.

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
 *
 * @param {{ token_id: string, payload_key: string }} invite
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

/**
 * Retrieve any pending-invite stash. Caller is responsible for clearing
 * after a successful (or definitively-failed) accept.
 *
 * @returns {{ token_id: string, payload_key: string } | null}
 */
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
 * Extract `{ token_id, payload_key }` from an invite URL or from the current
 * window location (when called with no argument). Returns null if the URL
 * does not match the expected shape.
 *
 * Two-secret format:
 *   https://*.example/invite/<token_id>#<payload_key>
 *
 * - `token_id` is the path segment immediately after `/invite/`.
 * - `payload_key` is the URL fragment (everything after `#`, leading `#`
 *   stripped).
 *
 * Both must be non-empty.
 *
 * @param {string|URL|Location} [input]
 * @returns {{ token_id: string, payload_key: string } | null}
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
      // Use a base if the input is path-only.
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

  // Match /invite/<id>; trailing slash optional.
  const match = pathname.match(/^\/invite\/([^/?#]+)\/?$/);
  if (!match) return null;
  const tokenId = decodeURIComponent(match[1]);
  if (!tokenId) return null;

  const payloadKey = (hash || '').replace(/^#/, '');
  if (!payloadKey) return null;

  return { token_id: tokenId, payload_key: payloadKey };
}

// ============ Pending-label storage (recipient side) ============

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

/**
 * Stash a label keyed by the inviter's share_pub so we can apply it once the
 * connection appears in `listConnections`. Used by the recipient flow.
 *
 * @param {string} sharePub - inviter's share_pub (base64url)
 * @param {string} label - the recipient's chosen friend label
 */
export function rememberPendingLabel(sharePub, label) {
  if (!sharePub || typeof sharePub !== 'string') return;
  const trimmed = (label || '').trim();
  if (!trimmed) return;
  const map = readPendingLabelMap();
  map[sharePub] = { label: trimmed, set_at: Date.now() };
  writePendingLabelMap(map);
}

/**
 * Apply any pending labels to connections that have materialized. Called by
 * `listConnections` automatically; can also be called explicitly after a
 * sync to settle labels eagerly.
 *
 * Idempotent: connections that already have a non-null label are skipped,
 * and the pending entry is dropped once applied.
 *
 * @returns {Promise<{ applied: number }>}
 */
export async function applyPendingLabels() {
  const map = readPendingLabelMap();
  const sharePubs = Object.keys(map);
  if (sharePubs.length === 0) return { applied: 0 };

  if (!tarnService.isLoggedIn()) return { applied: 0 };
  let client;
  try {
    client = await tarnService.getClient();
  } catch {
    return { applied: 0 };
  }

  let connections;
  try {
    connections = await client.listConnections();
  } catch {
    return { applied: 0 };
  }

  let applied = 0;
  let mutated = false;
  for (const sharePub of sharePubs) {
    const entry = map[sharePub];
    const conn = connections.find(c => c.share_pub === sharePub);
    if (!conn) continue;

    // Always overwrite — the recipient's pending label is more authoritative
    // than whatever the SDK auto-seeded. (In practice the SDK does not seed
    // a label on the recipient's side; the inviter's auto-accept seeded an
    // unhelpful label on the inviter's side. But on the recipient's side,
    // the connection arrives with label=null. We set the user's chosen one
    // here.)
    try {
      await client.setConnectionLabel({ share_pub: sharePub }, entry.label);
      applied++;
    } catch (err) {
      console.warn('[Bookish:Friends] setConnectionLabel failed:', err.message);
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
 * Generate a single-use invite. Calls Tarn's `createInviteToken`, which
 * uploads the encrypted payload to the API and returns the share-ready URL
 * (path token_id + fragment payload_key).
 *
 * @param {{ displayName?: string, expiryDays?: number }} [opts]
 * @returns {Promise<{ token_id: string, invite_url: string, expires_at: number, parsed: { token_id: string, payload_key: string } | null }>}
 */
export async function generateInvite(opts = {}) {
  const client = await tarnService.getClient();
  const created = await client.createInviteToken({
    display_name: opts.displayName ?? '',
    expiry_days: opts.expiryDays ?? 7,
  });
  const parsed = parseInviteUrl(created.invite_url);
  return { ...created, parsed };
}

// ============ Invite preview (recipient, non-consuming) ============

/**
 * Non-consuming preview of an invite. Returns null on expired / used /
 * not-found / wrong-key — does not throw on the recoverable failure modes,
 * matching the SDK contract.
 *
 * @param {{ token_id: string, payload_key: string }} args
 * @returns {Promise<{ inviter_display_name: string, inviter_share_pub_fingerprint: string, app_id: string, issued_at: number, expires_at: number } | null>}
 */
export async function previewInvite({ token_id, payload_key }) {
  const client = await tarnService.getClient();
  return await client.previewInviteToken(token_id, payload_key);
}

// ============ Invite accept (recipient) ============

/**
 * Redeem an invite and remember the recipient's chosen label so it can be
 * applied to the connection when it materializes. The connection only
 * appears in `listConnections` after the inviter's session auto-accepts;
 * label propagation happens inside `applyPendingLabels` (called from
 * `listConnections` and again after each sync).
 *
 * Throws on unrecoverable failure modes (404 / 410 / 409 / wrong-key /
 * app-mismatch). The caller's UI should surface those distinctly using the
 * `code` property the SDK attaches to the error.
 *
 * @param {{ token_id: string, payload_key: string, label: string }} args
 * @returns {Promise<{ requestNonce: string, inviterSharePub: string }>}
 */
export async function acceptInvite({ token_id, payload_key, label }) {
  const client = await tarnService.getClient();
  const result = await client.redeemInviteToken(token_id, payload_key);
  // SDK returns `recipientSharePubBase64Url` as the *inviter's* share_pub
  // (the field name is from the perspective of the inbox-publish primitive,
  // which addresses the inviter as "recipient"). Stash the chosen label
  // against this so applyPendingLabels can find it later.
  const inviterSharePub = result.recipientSharePubBase64Url;
  if (label && inviterSharePub) {
    rememberPendingLabel(inviterSharePub, label);
  }
  // Best-effort: try to apply now in case the connection already exists
  // (e.g. multi-device race). Cheap if no match.
  try { await applyPendingLabels(); } catch { /* ignore */ }
  return { requestNonce: result.requestNonce, inviterSharePub };
}

// ============ Read-side surfaces ============

/**
 * List the user's connections. Wraps `listConnections` and opportunistically
 * applies any pending labels (cheap no-op if none).
 *
 * @returns {Promise<Array<{ email: string, share_pub: string, signing_pub: string, established_at: number, initial_request_nonce: string, label: string | null }>>}
 */
export async function listConnections() {
  if (!tarnService.isLoggedIn()) return [];
  // Try to apply pending labels first so the returned list reflects them.
  try { await applyPendingLabels(); } catch { /* ignore */ }
  const client = await tarnService.getClient();
  return await client.listConnections();
}

/**
 * List the user's outstanding issued invites (sender side).
 * @returns {Promise<Array<{ token_id: string, display_name: string, issued_at: number, expires_at: number, redeemed_at: number | null, redeemer_share_pub_fingerprint: string | null }>>}
 */
export async function listIssuedInvites() {
  if (!tarnService.isLoggedIn()) return [];
  const client = await tarnService.getClient();
  return await client.listIssuedInvites();
}

/**
 * Revoke an issued invite. Best-effort server delete + local cleanup.
 * @param {string} token_id
 * @returns {Promise<{ revoked: boolean }>}
 */
export async function revokeInvite(token_id) {
  const client = await tarnService.getClient();
  return await client.revokeIssuedInvite(token_id);
}

/**
 * Trigger a poll of incoming connection requests. Used by the recipient
 * after `acceptInvite` — the eventual auto-accept from the inviter lands in
 * our inbox; calling `listIncomingRequests` processes any pending accepts
 * and adds the new connection to our connections record. Safe to call
 * repeatedly.
 *
 * @returns {Promise<void>}
 */
export async function pollForConnectionUpdates() {
  if (!tarnService.isLoggedIn()) return;
  let client;
  try { client = await tarnService.getClient(); } catch { return; }
  try { await client.listIncomingRequests(); } catch (err) {
    console.warn('[Bookish:Friends] listIncomingRequests failed:', err.message);
  }
  try { await applyPendingLabels(); } catch { /* ignore */ }
  // Notify listeners that the connection set may have changed. Cheap
  // fire-and-forget — the trigger refresh + drawer re-render handle their
  // own listConnections fetches on the back of this signal.
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bookish:connections-changed'));
    }
  } catch { /* ignore */ }
}

// ============ Friend's-shelf read flow (issue #123) ============

// Tarn blob format prefix (5 bytes 'T','A','R','N',0x02). The owner-side
// SDK strips this internally; we re-implement the recipient-side decrypt
// here because the SDK does not (yet) expose a helper that takes a
// share-log CEK and a blob and returns plaintext.
//
// Per TARN_PROTOCOL.md §"Reading":
//   "A recipient with a CEK from a share log skips the wrapped portion
//    and decrypts directly."
//
// Layout: magic(5) || wrapped_CEK(40) || iv(12) || ciphertext+GCM_tag
// The friend has the bare CEK from the share log, so we read iv at
// bytes 45..56 and decrypt bytes 57..end with AES-GCM(CEK).
const TARN_BLOB_MAGIC = new Uint8Array([0x54, 0x41, 0x52, 0x4e, 0x02]);
const WRAPPED_CEK_LEN = 40;
const IV_LEN = 12;

function hasTarnBlobMagic(bytes) {
  if (!bytes || bytes.length < TARN_BLOB_MAGIC.length) return false;
  for (let i = 0; i < TARN_BLOB_MAGIC.length; i++) {
    if (bytes[i] !== TARN_BLOB_MAGIC[i]) return false;
  }
  return true;
}

function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Decrypt a Tarn blob using a CEK from a share log. Returns the parsed
 * JSON payload. Throws on malformed magic or decrypt failure (caller
 * decides whether to skip or surface).
 *
 * Exported for unit tests.
 */
export async function _decryptSharedBlobForTest(blobBytes, cekBase64Url) {
  if (!hasTarnBlobMagic(blobBytes)) {
    throw new Error('Blob does not have TARN magic prefix');
  }
  if (blobBytes.length < TARN_BLOB_MAGIC.length + WRAPPED_CEK_LEN + IV_LEN + 16) {
    throw new Error('Blob too short for new format');
  }
  const ivStart = TARN_BLOB_MAGIC.length + WRAPPED_CEK_LEN;
  const iv = blobBytes.slice(ivStart, ivStart + IV_LEN);
  const ciphertext = blobBytes.slice(ivStart + IV_LEN);
  const cekBytes = base64UrlToBytes(cekBase64Url);
  const cekKey = await crypto.subtle.importKey(
    'raw', cekBytes, { name: 'AES-GCM' }, false, ['decrypt'],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, cekKey, ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

const ARWEAVE_GATEWAYS = [
  'https://turbo-gateway.com/',
  'https://arweave.net/',
];

/**
 * Fetch a single Arweave blob with gateway fallback. Returns the raw bytes
 * or null on total failure. Pure function — no logging, no caching.
 */
async function fetchArweaveBlob(txId, fetchImpl = globalThis.fetch) {
  for (const gw of ARWEAVE_GATEWAYS) {
    try {
      const res = await fetchImpl(`${gw}${encodeURIComponent(txId)}`, {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(10000)
          : undefined,
      });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {
      // Try next gateway.
    }
  }
  return null;
}

/**
 * Fetch a friend's published library by reading their share log and
 * decrypting each shared blob. Returns book records in the same shape the
 * Library grid renders (so the friend's-shelf view can pass the result
 * straight to the existing card builders without extra adapter work).
 *
 * Empty share log → empty array (the friend hasn't published anything).
 * Per-entry decrypt or fetch failure → that entry is skipped with a
 * console.warn; the remaining entries are returned. The view treats a
 * total fetch failure (readShareLog throws) as the error state.
 *
 * Note on architecture: today, Bookish does not yet *publish* books to
 * the share log — that wiring lands with issue #8 (per-book privacy)
 * which gates publication on the per-book privacy flag. Until issue #8
 * ships, every friend's `readShareLog` call returns the empty handshake
 * snapshot and this function returns []. The empty-state UI handles that
 * case naturally.
 *
 * @param {{ share_pub: string, signing_pub: string, label?: string|null }} connection
 * @param {{ fetchImpl?: typeof fetch }} [opts] - injectable fetch for tests
 * @returns {Promise<Array<Object>>}
 */
export async function fetchFriendLibrary(connection, opts = {}) {
  if (!connection || !connection.share_pub || !connection.signing_pub) {
    throw new Error('fetchFriendLibrary: connection.share_pub and signing_pub are required');
  }
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const client = await tarnService.getClient();

  // readShareLog returns { content_id: { tx_id, cek } }. Empty object means
  // the friend has published nothing (or only the handshake snapshot).
  const state = await client.readShareLog(connection);
  const entries = Object.entries(state || {});
  if (entries.length === 0) return [];

  // Fetch + decrypt each shared blob in parallel (bounded). Skips any
  // entry that fails so a single bad entry can't blank the whole shelf.
  const CONCURRENCY = 10;
  const results = [];
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(async ([contentId, info]) => {
      if (!info || !info.tx_id || !info.cek) return null;
      const blob = await fetchArweaveBlob(info.tx_id, fetchImpl);
      if (!blob) {
        console.warn('[Bookish:Friends] fetchFriendLibrary: blob fetch failed for', contentId);
        return null;
      }
      try {
        const data = await _decryptSharedBlobForTest(blob, info.cek);
        // Normalize to the Library entry shape: txid + spread payload.
        // The friend's shelf view never writes back, so we don't carry
        // status / pending / sync flags.
        return { txid: info.tx_id, ...data };
      } catch (err) {
        console.warn('[Bookish:Friends] fetchFriendLibrary: decrypt failed for', contentId, err.message);
        return null;
      }
    }));
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
  }
  return results;
}

// ============ Friend-library matching cache (issue #126) ============
//
// Friend pips on Library cards (FRIENDS.md Surface 3) need a fast lookup:
// "for this work_key, which of my friends have it on Reading or Read?"
// A Library grid with 100 books would otherwise trigger 100 share-log scans
// per render — unacceptable. We cache the inverted index keyed by work_key.
//
// Cache shape: Map<workKey, Array<{ connection, book }>>
//   connection: the friend's connection object (label, share_pub, …)
//   book:       the friend's per-book record from their share-log snapshot
//               (title, author, dateRead, readingStatus, work_key, …). The
//               book is captured so pip-tap → friend-book-detail can show
//               the friend's dateRead and other per-friend metadata, not
//               just the friend's identity.
//
// - Built once per refresh from each friend's library snapshot.
// - Friends with the work in `Want to Read` status are excluded (per spec —
//   WTR is too soft a signal for ambient pips).
// - Muted connections are excluded (per FRIENDS.md mute semantics).
// - Books without a `work_key` contribute nothing — strict equality only,
//   no fuzzy matching ever.
//
// Refresh model: opportunistic on first call, then re-primed on
// `bookish:connections-changed` and `bookish:friend-libraries-refreshed`.
// The latter is a new event we dispatch from primeFriendLibraryCache itself
// (so other surfaces — e.g. activity.js, future drawer surfaces — can also
// listen if they ever need to). The render loop in app.js subscribes and
// re-renders the grid when the cache repaints.
//
// Today, every friend's `fetchFriendLibrary` returns [] (publish-on-save
// lands in #8). The cache stays empty and `getMatchingFriends` returns []
// for every work_key — no pips render. The moment publish-on-save ships,
// the same code lights up automatically.

// Test seam: callers of primeFriendLibraryCache reach into the module's own
// listConnections + fetchFriendLibrary by default, but tests can override
// via _setMatchCacheDepsForTest so they don't need to fake the underlying
// Tarn client / Arweave fetch.
let _matchCacheDeps = null;

let _matchCache = null;          // Map<workKey, Array<{connection, book}>> | null when not primed
let _primingPromise = null;      // in-flight prime, dedupes concurrent callers
let _cacheGeneration = 0;        // bumped on each successful prime; lets tests + UI confirm refresh

/**
 * Best-effort isMuted check that fails open. Mirrors activity.js semantics:
 * if the SDK can't tell us, treat the friend as unmuted — the failure mode
 * of "we showed pips for a friend you muted on a transient client error" is
 * gentler than "we hid all your pips."
 */
async function isConnectionMuted(client, conn) {
  if (!client || typeof client.isMuted !== 'function') return false;
  try {
    return await client.isMuted(conn);
  } catch {
    return false;
  }
}

/**
 * Filter a friend's book record list down to entries that should contribute
 * a pip. Status filter is per spec: only Reading or Read counts; WTR does
 * not. Books without a `work_key` are dropped (no pip without strict id).
 *
 * Exported for tests so the filter rules can be asserted directly.
 *
 * @param {Array<object>} books
 * @returns {Array<object>}
 */
export function filterPippableBooks(books) {
  if (!Array.isArray(books)) return [];
  const out = [];
  for (const b of books) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.work_key !== 'string' || !b.work_key) continue;
    const rs = b.readingStatus;
    // Default (absent / null) treats the book as Read — same convention
    // applied throughout the codebase via normalizeReadingStatus. Only WTR
    // is excluded from pip contribution.
    if (rs === 'want_to_read') continue;
    out.push(b);
  }
  return out;
}

/**
 * Prime the friend-library match cache by fetching each non-muted friend's
 * library and folding it into a `work_key → connections` map.
 *
 * Idempotent: concurrent callers share a single in-flight prime. Subsequent
 * calls re-fetch only when explicitly told to via `force: true` or when the
 * cache has been invalidated via `invalidateFriendLibraryCache`.
 *
 * Dispatches `bookish:friend-libraries-refreshed` on the window after a
 * successful prime so subscribers (Library render loop) can repaint.
 *
 * @param {{ force?: boolean, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ generation: number, friendCount: number, workKeyCount: number }>}
 */
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

    let client = null;
    try { client = await tarnService.getClient(); } catch { /* fail-open below */ }

    // Filter muted connections up front so we don't burn fetches on them.
    const visible = [];
    for (const conn of connections) {
      if (!conn || !conn.share_pub) continue;
      const muted = await isConnectionMuted(client, conn);
      if (!muted) visible.push(conn);
    }

    const fetchOpts = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined;
    const results = await Promise.allSettled(
      visible.map(conn => fetchFn(conn, fetchOpts)),
    );

    const next = new Map();
    results.forEach((r, idx) => {
      if (r.status !== 'fulfilled') {
        console.warn(
          '[Bookish:Friends] primeFriendLibraryCache: fetchFriendLibrary failed for',
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
          // Defensively dedupe by share_pub so a friend who has the same work
          // in two records (shouldn't happen, but cheap to guard) doesn't get
          // double-pipped. First-write wins.
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

/**
 * Drop the cached match index so the next call to getMatchingFriends or
 * primeFriendLibraryCache re-fetches. Used by the connection-change wiring
 * in app.js so add/remove/mute changes promptly invalidate stale pips.
 */
export function invalidateFriendLibraryCache() {
  _matchCache = null;
}

/**
 * Synchronously look up the friends who have a given book on their shelf
 * (Reading or Read), excluding muted ones, in a stable order.
 *
 * Returns the connection objects only — the legacy / FRIENDS.md-spec shape.
 * Use {@link getMatchingFriendBookEntries} when you need the friend's per-book
 * record alongside the connection (e.g. for pip-tap → friend-book-detail
 * with the friend's dateRead).
 *
 * If the cache hasn't been primed yet, returns [] and kicks off a background
 * prime — the resulting `bookish:friend-libraries-refreshed` event tells the
 * caller to re-render.
 *
 * Strict work_key equality only — books without a work_key match nothing.
 *
 * @param {string|null|undefined} workKey
 * @returns {Array<{ share_pub: string, label?: string|null, signing_pub?: string }>}
 */
export function getMatchingFriends(workKey) {
  return getMatchingFriendBookEntries(workKey).map(entry => entry.connection);
}

/**
 * Like {@link getMatchingFriends}, but returns the full `{ connection, book }`
 * tuples so callers can hand the friend's specific book record to surfaces
 * that show per-friend metadata (e.g. friend-book-detail's "Finished {Mon
 * YYYY}" line, which reads from the friend's dateRead).
 *
 * @param {string|null|undefined} workKey
 * @returns {Array<{ connection: object, book: object }>}
 */
export function getMatchingFriendBookEntries(workKey) {
  if (!workKey || typeof workKey !== 'string') return [];
  if (_matchCache === null) {
    // Lazy prime — caller will see [] this turn but receive the refresh event.
    primeFriendLibraryCache().catch(() => { /* swallow; a console.warn already ran */ });
    return [];
  }
  const list = _matchCache.get(workKey);
  if (!list || list.length === 0) return [];
  // Stable order: most recently established friend first (consistent with
  // friend-strip ordering). Tie-break on share_pub for determinism.
  return [...list].sort((a, b) => {
    const ea = a.connection.established_at || 0;
    const eb = b.connection.established_at || 0;
    if (ea !== eb) return eb - ea;
    return (a.connection.share_pub || '').localeCompare(b.connection.share_pub || '');
  });
}

/**
 * Test-only accessor for the current cache generation. The render loop also
 * uses this to detect freshness without holding a reference to the Map.
 */
export function _getMatchCacheGenerationForTest() { return _cacheGeneration; }

/**
 * Test-only reset — flushes the cache and cancels any in-flight prime
 * promise. Modules under test should call this in beforeEach so tests don't
 * see leakage from each other.
 */
export function _resetMatchCacheForTest() {
  _matchCache = null;
  _primingPromise = null;
  _cacheGeneration = 0;
  _matchCacheDeps = null;
}

/**
 * Test-only seam: replace the listConnections / fetchFriendLibrary functions
 * primeFriendLibraryCache uses, so unit tests can supply pure fixtures
 * without faking the Tarn client + Arweave fetch underneath.
 *
 * Pass `null` (or call _resetMatchCacheForTest) to restore real wiring.
 *
 * @param {{ listConnections?: Function, fetchFriendLibrary?: Function } | null} deps
 */
export function _setMatchCacheDepsForTest(deps) {
  _matchCacheDeps = deps;
}

// Storage key exports for tests + cleanup paths.
export const STORAGE_KEYS = {
  PENDING_LABELS: PENDING_LABELS_KEY,
  PENDING_INVITE: PENDING_INVITE_KEY,
};
