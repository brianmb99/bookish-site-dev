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

// Storage key exports for tests + cleanup paths.
export const STORAGE_KEYS = {
  PENDING_LABELS: PENDING_LABELS_KEY,
  PENDING_INVITE: PENDING_INVITE_KEY,
};
