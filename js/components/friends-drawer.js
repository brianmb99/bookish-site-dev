// friends-drawer.js — Surface 1 of the Friends feature (issue #122).
//
// The drawer is a peer of the existing WTR drawer. It uses the same chrome
// pattern (bottom sheet on touch / right panel on desktop), the same
// swipe-to-dismiss helper, and the same overlay-history wiring so the
// system back button closes it predictably on the standalone PWA.
//
// Two regions inside one drawer:
//
//   Region A — "Recent finishes" events. Empty in this issue; issue #5
//     fills it. Implemented as a slot we leave unmounted so the drawer
//     degrades cleanly into "Region B only" until then.
//
//   Region B — friend strip. See friend-strip.js. Always present when the
//     drawer is open (the trigger gate in app.js means the drawer can only
//     open when ≥1 connection exists).
//
// The trigger glyph in the header lives in friend-glyph-trigger.js. This
// module owns drawer chrome + lifecycle + region rendering only.

import * as friends from '../core/friends.js';
import { attachSwipeDismiss } from '../core/swipe_dismiss.js';
import { pushOverlayState, popOverlayState } from '../core/overlay_history.js';
import { renderFriendStrip } from './friend-strip.js';

const OVERLAY_ID = 'friendsOverlay';
const DRAWER_ID = 'friendsDrawer';
const BACKDROP_ID = 'friendsBackdrop';
const STRIP_HOST_ID = 'friendsStripHost';
const EVENTS_HOST_ID = 'friendsEventsHost';
const CLOSE_ID = 'friendsClose';

let _isOpen = false;
let _resetSwipe = null;
let _focusReturnEl = null;
let _keydownHandler = null;

function ensureMarkup() {
  if (document.getElementById(OVERLAY_ID)) return;
  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  root.style.display = 'none';
  // Mirror the WTR drawer markup shape — the CSS in styles.css leans on the
  // same class structure (.friends-backdrop / .friends-drawer / .friends-header
  // / .friends-drawer-handle) plus its own friend-strip subtree.
  root.innerHTML = `
    <div class="friends-backdrop" id="${BACKDROP_ID}"></div>
    <div class="friends-drawer" id="${DRAWER_ID}" role="dialog" aria-modal="true" aria-labelledby="friendsDrawerTitle">
      <div class="friends-drawer-handle" aria-hidden="true"></div>
      <div class="friends-header">
        <h3 class="friends-title" id="friendsDrawerTitle">Friends</h3>
        <button type="button" class="modal-close-btn" id="${CLOSE_ID}" aria-label="Close">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
          </svg>
        </button>
      </div>
      <div class="friends-events" id="${EVENTS_HOST_ID}"></div>
      <div class="friends-strip-host" id="${STRIP_HOST_ID}"></div>
    </div>
  `;
  document.body.appendChild(root);

  document.getElementById(BACKDROP_ID).addEventListener('click', () => closeFriendsDrawer());
  document.getElementById(CLOSE_ID).addEventListener('click', () => closeFriendsDrawer());
}

/**
 * Re-render the strip with the latest connections. Called both on open and
 * after an invite-modal dismiss (so newly-added friends materialize without
 * a full drawer reopen). Cheap if connections haven't changed.
 *
 * Pulls connections directly from `friends.listConnections()` so the drawer
 * is the single source of truth for what it shows; callers don't have to
 * pass anything in.
 */
async function refreshStrip() {
  const host = document.getElementById(STRIP_HOST_ID);
  if (!host) return;
  let connections = [];
  try {
    connections = await friends.listConnections();
  } catch (err) {
    console.warn('[Bookish:FriendsDrawer] listConnections failed:', err.message);
  }
  renderFriendStrip(host, connections, {
    onAddClick: openInviteFlow,
    onAvatarTap: handleAvatarTap,
    onAvatarLongPress: handleAvatarLongPress,
  });
}

/**
 * Stub for issue #4 — friend's full-screen shelf. For now we log and stay
 * in the drawer so the user can see the breadcrumb and we don't paint over
 * an undefined surface.
 */
function handleAvatarTap(connection) {
  // Issue 4 will replace this with a proper shelf navigation. The console
  // log doubles as a smoke-test signal for the browser test in this issue.
  console.log('[Bookish:Friends] tap friend (issue 4 stub):', {
    label: connection.label,
    share_pub: (connection.share_pub || '').slice(0, 8),
  });
  // Surface a hook on window so the browser test can detect the call without
  // depending on console output capture (which is flaky across browsers).
  if (typeof window !== 'undefined') {
    window.__bookishLastFriendTap = {
      label: connection.label || null,
      share_pub: connection.share_pub || null,
      at: Date.now(),
    };
  }
}

/**
 * Stub for issue #10 — overflow menu (Mute / Remove). Same pattern as the
 * tap stub: log + window hook for tests.
 */
function handleAvatarLongPress(connection /* , anchorEl */) {
  console.log('[Bookish:Friends] long-press friend (issue 10 stub):', {
    label: connection.label,
    share_pub: (connection.share_pub || '').slice(0, 8),
  });
  if (typeof window !== 'undefined') {
    window.__bookishLastFriendLongPress = {
      label: connection.label || null,
      share_pub: connection.share_pub || null,
      at: Date.now(),
    };
  }
}

/**
 * Opens the existing invite modal from issue #2. Lazy-imports it so the
 * drawer's first paint isn't gated on the QR vendor bundle.
 */
async function openInviteFlow() {
  try {
    const mod = await import('./invite-modal.js');
    await mod.openInviteModal();
  } catch (err) {
    console.error('[Bookish:FriendsDrawer] openInviteModal failed:', err);
  }
}

function trapFocusKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFriendsDrawer();
    return;
  }
  if (e.key !== 'Tab') return;
  const drawer = document.getElementById(DRAWER_ID);
  if (!drawer) return;
  // Collect focusables; cheap re-query each time (drawer is small).
  const focusables = drawer.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Open the Friends drawer. Idempotent — calling while open is a no-op.
 *
 * @param {{ returnFocusTo?: HTMLElement | null }} [opts]
 */
export async function openFriendsDrawer(opts = {}) {
  if (_isOpen) return;
  ensureMarkup();
  const overlay = document.getElementById(OVERLAY_ID);
  const drawer = document.getElementById(DRAWER_ID);
  if (!overlay || !drawer) return;

  _focusReturnEl = opts.returnFocusTo || document.activeElement || null;

  overlay.style.display = 'block';
  document.body.classList.add('modal-open');
  _isOpen = true;
  pushOverlayState('friends');

  // Hydrate the strip async (Tarn calls). The drawer chrome paints
  // immediately; the strip materializes a beat later.
  refreshStrip().catch(err =>
    console.warn('[Bookish:FriendsDrawer] strip hydrate failed:', err.message),
  );

  // Keyboard: ESC + focus trap.
  _keydownHandler = trapFocusKeydown;
  document.addEventListener('keydown', _keydownHandler);

  // Initial focus on the close button so keyboard users can dismiss
  // immediately without having to tab through the strip.
  requestAnimationFrame(() => {
    const close = document.getElementById(CLOSE_ID);
    if (close) close.focus({ preventScroll: true });
  });

  // Swipe-to-dismiss on touch devices, mirroring the WTR drawer wiring.
  if (window.matchMedia?.('(pointer: coarse)').matches) {
    const handle = drawer.querySelector('.friends-drawer-handle');
    const header = drawer.querySelector('.friends-header');
    const handles = [handle, header].filter(Boolean);
    if (handles.length) {
      _resetSwipe = attachSwipeDismiss({
        sheet: drawer,
        handles,
        onDismiss: () => closeFriendsDrawer(),
      });
    }
  }
}

/**
 * Close the drawer. Safe to call when not open.
 *
 * @param {boolean} [fromPopstate]
 */
export function closeFriendsDrawer(fromPopstate = false) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) { _isOpen = false; return; }
  if (_resetSwipe) { _resetSwipe(); _resetSwipe = null; }
  overlay.style.display = 'none';
  document.body.classList.remove('modal-open');
  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = null;
  }
  if (_isOpen && !fromPopstate) popOverlayState();
  _isOpen = false;

  // Return focus to whatever opened us (header glyph trigger, typically),
  // so keyboard users land where they came from.
  if (_focusReturnEl && typeof _focusReturnEl.focus === 'function') {
    try { _focusReturnEl.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  _focusReturnEl = null;
}

export function isFriendsDrawerOpen() { return _isOpen; }

// Test hook — let the unit tests force a re-render without going through
// the open path (which has DOM/timing requirements).
export const _refreshStripForTest = refreshStrip;
