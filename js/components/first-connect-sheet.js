// first-connect-sheet.js — One-time privacy education on first friend.
//
// FRIENDS.md / Surface 7 → "First-connect education". When a user accepts
// their first ever connection (transition from 0 → 1), we surface a single
// bottom sheet explaining that the friend can see their shelf and that any
// book can be marked private. Shown exactly once per device, ever.
//
// Why per-device (not Tarn-synced):
//   The sheet is education, not enforcement. A user who installs Bookish on a
//   second device gets a second showing — that's fine; the message is "what
//   you should know now that you have a friend." We avoid the protocol cost
//   of a synced flag and the awkwardness of a sheet popping up days later
//   when state finally syncs in. (See FRIENDS.md, Surface 7 → "Stored as a
//   local flag.")
//
// Trigger:
//   The accept-invite-modal calls `maybeShowFirstConnectSheet()` after a
//   successful redeem (reason='done' close). The connection materializes
//   asynchronously after the inviter session auto-accepts, so we poll
//   briefly (a few short retries) to catch the connection's first appearance
//   in `listConnections()`. If after the poll window we still see < 1
//   connection, we silently bail — the user will not see the sheet this
//   round, but the flag stays unset so a *future* accept will fire it.
//
// Idempotence:
//   The flag is set the moment the sheet opens (not on dismiss) so a refresh
//   mid-view doesn't re-fire on next launch. Once true, the sheet is
//   permanently disabled per device — even if the user removes all friends
//   and accepts a new one later (per spec: "once per device, not once per
//   N-th first connection").
//
// Pronoun choice:
//   The spec mock-up used "She" with the example name "Maya". Inferring
//   gender from a label is unsafe and exclusionary. Default to the
//   gender-neutral "They" — fits any label and avoids misgendering anyone.

import * as friends from '../core/friends.js';
import * as tarnService from '../core/tarn_service.js';
import { pushOverlayState, popOverlayState } from '../core/overlay_history.js';

// localStorage key for the per-device "first connect education shown" flag.
// Value 'true' means the sheet has been shown and must never appear again.
// Lives in the `bookish:friends:*` namespace from #124's hide-from-header
// preference, keeping all local Friends-feature flags in one place.
export const FIRST_CONNECT_SHOWN_LS_KEY = 'bookish:friends:first-connect-shown';

const SHEET_ID = 'firstConnectSheet';
const TITLE_ID = 'firstConnectSheetTitle';

// Polling parameters for waiting on the connection to materialize after
// accept. Total wait: ~2 seconds across 4 attempts (250, 500, 750, 750ms).
// Kept small — if the inviter is offline we'd wait minutes for the connection
// to land, which is far longer than the user wants to be staring at a closed
// modal. A miss here is fine; the sheet will fire on the *next* accept.
const POLL_DELAYS_MS = [250, 500, 750, 750];

let _isOpen = false;

// Test seam: lets unit tests inject a stub `friends` module without faking
// the entire Tarn client. Production callers leave this null.
let _depsForTest = null;

/**
 * Test-only seam: replace the friends module reference used by
 * maybeShowFirstConnectSheet with a stub. Pass null to restore.
 *
 * @param {{ listConnections?: Function } | null} deps
 */
export function _setDepsForTest(deps) {
  _depsForTest = deps;
}

function getFriendsModule() {
  return _depsForTest || friends;
}

/**
 * Read the per-device "shown" flag. Defaults to false on missing key,
 * malformed value, or environments without localStorage.
 *
 * @returns {boolean}
 */
export function hasShownFirstConnectSheet() {
  try {
    return localStorage.getItem(FIRST_CONNECT_SHOWN_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Mark the sheet as shown. Called the moment we open the sheet (not on
 * dismiss) so a refresh mid-view doesn't re-fire on relaunch.
 */
function markShown() {
  try {
    localStorage.setItem(FIRST_CONNECT_SHOWN_LS_KEY, 'true');
  } catch (err) {
    console.warn('[Bookish:FirstConnectSheet] localStorage write failed:', err.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function ensureMarkup() {
  if (document.getElementById(SHEET_ID)) return;
  const root = document.createElement('div');
  root.id = SHEET_ID;
  root.className = 'modal-overlay';
  root.style.display = 'none';
  root.innerHTML = `
    <div class="modal-backdrop" data-first-connect-backdrop></div>
    <div class="first-connect-sheet" role="dialog" aria-modal="true" aria-labelledby="${TITLE_ID}">
      <div class="first-connect-pane">
        <h2 id="${TITLE_ID}" class="first-connect-title"></h2>
        <p class="first-connect-body">
          They can see the books on your shelf.
          Mark any book as private — it stays in your library
          but only you see it.
        </p>
        <div class="first-connect-actions">
          <button type="button" class="btn primary" data-first-connect-dismiss>Got it</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  root.querySelector('[data-first-connect-backdrop]').addEventListener('click', () => {
    closeFirstConnectSheet('backdrop');
  });
  root.querySelector('[data-first-connect-dismiss]').addEventListener('click', () => {
    closeFirstConnectSheet('dismiss');
  });
}

/**
 * Open the sheet for a given friend label. Idempotent: a second call while
 * the sheet is already open is a no-op.
 *
 * Sets the per-device flag immediately (not on dismiss) so a refresh during
 * the showing doesn't re-fire on next launch. Per spec: "once per device,
 * ever" — even an aborted view counts.
 *
 * @param {{ label: string | null | undefined }} args
 */
export function openFirstConnectSheet({ label } = {}) {
  if (_isOpen) return;
  ensureMarkup();
  const sheet = document.getElementById(SHEET_ID);
  const title = document.getElementById(TITLE_ID);
  if (!sheet || !title) return;

  // Fall back gracefully if for some reason no label arrived.
  const friendName = (label && String(label).trim()) || 'Your new friend';
  title.textContent = `${friendName} is now your friend.`;

  sheet.style.display = 'flex';
  document.body.classList.add('modal-open');
  _isOpen = true;
  markShown();
  pushOverlayState('first-connect-sheet');

  // Defer focus so it lands after the sheet animates in. The dismiss button
  // is the only actionable target — it's the natural focus.
  setTimeout(() => {
    const btn = sheet.querySelector('[data-first-connect-dismiss]');
    if (btn && typeof btn.focus === 'function') {
      try { btn.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }, 0);
}

/**
 * Close the sheet. Triggered by the dismiss button, the backdrop, or
 * (defensively) external callers. The 'fromPopstate' guard mirrors the
 * accept-invite modal's pattern so popping the overlay history doesn't
 * double-pop.
 *
 * @param {string} [reason]
 * @param {boolean} [fromPopstate]
 */
export function closeFirstConnectSheet(reason = 'dismiss', fromPopstate = false) {
  const sheet = document.getElementById(SHEET_ID);
  if (!sheet) { _isOpen = false; return; }
  sheet.style.display = 'none';
  document.body.classList.remove('modal-open');
  if (_isOpen && !fromPopstate) popOverlayState();
  _isOpen = false;
}

/**
 * Sleep helper. Resolves after `ms` milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Trigger entry point. Called from the accept-invite-modal's success-close
 * path. Returns a promise that resolves when the check-and-maybe-show is
 * complete (or timed out). Failures are silent — the sheet is best-effort
 * education, not load-bearing UX.
 *
 * Decision logic:
 *   1. If the flag is already set → bail (sheet has fired before).
 *   2. If the user is not logged in → bail (defensive; shouldn't happen
 *      from the accept path, but cheap to guard).
 *   3. Poll listConnections() with short backoff for the connection to
 *      materialize. The connection arrives async after the inviter's
 *      session auto-accepts; pendingLabels apply on each poll.
 *   4. If we end up with exactly 1 connection → fire the sheet with that
 *      friend's label.
 *   5. If we end up with 0 connections (inviter offline / slow / failed
 *      handshake) → silently bail. The flag stays unset; the sheet will
 *      fire on the user's *next* successful accept.
 *   6. If we end up with > 1 connection at the end of polling → also bail.
 *      Either the user already had connections and this isn't their "first"
 *      (the spec's transition is 0 → 1), or some race added another. Either
 *      way, the educational moment has passed.
 *
 * @returns {Promise<{ shown: boolean, reason?: string }>}
 */
export async function maybeShowFirstConnectSheet() {
  if (hasShownFirstConnectSheet()) return { shown: false, reason: 'already-shown' };
  if (!tarnService.isLoggedIn()) return { shown: false, reason: 'not-logged-in' };

  const friendsModule = getFriendsModule();

  // Poll for the connection to land. listConnections() opportunistically
  // applies pending labels on each call (see friends.js → applyPendingLabels)
  // so by the time we read connection.label here it should be the user's
  // chosen name, not null.
  let connections = [];
  for (let i = 0; i < POLL_DELAYS_MS.length; i++) {
    try {
      connections = await friendsModule.listConnections();
    } catch {
      connections = [];
    }
    if (connections.length === 1) break;
    if (connections.length > 1) break; // exit early; not a first-connect anyway
    if (i < POLL_DELAYS_MS.length - 1) {
      await sleep(POLL_DELAYS_MS[i]);
    }
  }

  if (connections.length !== 1) {
    return { shown: false, reason: connections.length === 0 ? 'no-connection-yet' : 'not-first-connection' };
  }

  // We have a definite first connection. Show the sheet.
  const conn = connections[0];
  const label = (conn && typeof conn.label === 'string' ? conn.label : '') || '';
  openFirstConnectSheet({ label });
  return { shown: true };
}

// Test-only accessors / hooks.
export function _isOpenForTest() { return _isOpen; }
export function _resetForTest() {
  _isOpen = false;
  _depsForTest = null;
  const existing = document.getElementById(SHEET_ID);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  document.body.classList.remove('modal-open');
}
