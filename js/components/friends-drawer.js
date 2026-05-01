// friends-drawer.js — Surface 1 of the Friends feature (issues #122, #124, #125).
//
// The drawer is a peer of the existing WTR drawer. It uses the same chrome
// pattern (bottom sheet on touch / right panel on desktop), the same
// swipe-to-dismiss helper, and the same overlay-history wiring so the
// system back button closes it predictably on the standalone PWA.
//
// Two regions inside one drawer:
//
//   Region A — "Recent finishes" events (#125). Vertical list of friends'
//     recent `finished` events; renders only when there are events to show.
//     Today (publish-on-save deferred to #8) every friend's share log is
//     empty so the region stays empty for all users; the CSS rule
//     `.friends-events:empty { display: none }` keeps the layout clean.
//     The full rendering pipeline is wired and lights up automatically as
//     soon as real share-log entries exist.
//
//   Region B — friend strip. See friend-strip.js. When 0 connections, the
//     strip renders an empty state with a friendly message + prominent
//     "+ Add" button (#124 — the trigger is now always visible, so the
//     drawer must handle the zero-friends case gracefully).
//
// The drawer also exposes a small "Hide friends from header" link at the
// bottom (#124). Tapping it sets a per-device preference, hides the glyph
// immediately, shows a toast, and closes the drawer. Re-enable lives on
// the Account screen.
//
// The trigger glyph in the header lives in friend-glyph-trigger.js. This
// module owns drawer chrome + lifecycle + region rendering only.

import * as friends from '../core/friends.js';
import { attachSwipeDismiss } from '../core/swipe_dismiss.js';
import { pushOverlayState, popOverlayState } from '../core/overlay_history.js';
import { renderFriendStrip, displayNameForConnection } from './friend-strip.js';
import { setHideFriendsFromHeader } from './friend-glyph-trigger.js';
import { hydrateRecentFinishes } from './recent-finishes.js';
import { openFriendOverflowMenu } from './friend-overflow-menu.js';
import { openConfirmDialog } from './confirm-dialog.js';

const OVERLAY_ID = 'friendsOverlay';
const DRAWER_ID = 'friendsDrawer';
const BACKDROP_ID = 'friendsBackdrop';
const STRIP_HOST_ID = 'friendsStripHost';
const EVENTS_HOST_ID = 'friendsEventsHost';
const BANNER_ID = 'friendsAllMutedBanner';
const CLOSE_ID = 'friendsClose';
const HIDE_LINK_ID = 'friendsHideFromHeader';

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
      <div class="friends-all-muted-banner" id="${BANNER_ID}" hidden>
        You've muted everyone. Activity is hidden.
      </div>
      <div class="friends-events" id="${EVENTS_HOST_ID}"></div>
      <div class="friends-strip-host" id="${STRIP_HOST_ID}"></div>
      <div class="friends-drawer-footer">
        <button type="button" class="friends-hide-link" id="${HIDE_LINK_ID}">
          Hide friends from header
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  document.getElementById(BACKDROP_ID).addEventListener('click', () => closeFriendsDrawer());
  document.getElementById(CLOSE_ID).addEventListener('click', () => closeFriendsDrawer());
  const hideLink = document.getElementById(HIDE_LINK_ID);
  if (hideLink) hideLink.addEventListener('click', handleHideFromHeader);
}

/**
 * Handle the "Hide friends from header" link. Per #124 acceptance criterion 4:
 * sets the local flag (which fires a visibility-changed event the trigger
 * listens to), shows a brief confirmation toast, closes the drawer.
 *
 * We don't ask for confirmation — the action is fully reversible from
 * Account → Friends, and the toast tells the user where to undo it.
 */
function handleHideFromHeader() {
  setHideFriendsFromHeader(true);
  showHideConfirmationToast();
  closeFriendsDrawer();
}

/**
 * Lightweight toast — same shape as showStatusToast in app.js (deliberately
 * inlined so the drawer stays self-contained and doesn't import app.js).
 * Lives 3.5s, slightly longer than the default 2s to give the user time to
 * register the "Re-enable in Account" wayfinding hint.
 */
function showHideConfirmationToast() {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('bookishStatusToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'bookishStatusToast';
  toast.className = 'toast status-toast';
  toast.setAttribute('role', 'status');
  toast.innerHTML = `<span class="toast-message">Friends hidden. Re-enable in Account.</span>`;
  toast.style.cssText = 'position:fixed;top:calc(var(--header-height) + env(safe-area-inset-top) + 8px);left:50%;transform:translateX(-50%);z-index:9001;';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/**
 * Re-render the strip with the latest connections + muted state. Called on
 * open, after an invite-modal dismiss (so newly-added friends materialize
 * without a full drawer reopen), and after mute/unmute/remove actions.
 *
 * Pulls connections directly from `friends.listConnections()` so the drawer
 * is the single source of truth for what it shows; callers don't have to
 * pass anything in. Mute state is fetched in parallel via
 * `friends.getMutedSharePubs()` (fail-soft — empty set on any error).
 *
 * Also updates the all-friends-muted banner visibility based on the same
 * data: shown when connections.length > 0 AND every connection is muted.
 */
async function refreshStrip() {
  const host = document.getElementById(STRIP_HOST_ID);
  if (!host) return;
  let connections = [];
  let mutedSharePubs = new Set();
  try {
    [connections, mutedSharePubs] = await Promise.all([
      friends.listConnections().catch(err => {
        console.warn('[Bookish:FriendsDrawer] listConnections failed:', err.message);
        return [];
      }),
      friends.getMutedSharePubs().catch(() => new Set()),
    ]);
  } catch (err) {
    console.warn('[Bookish:FriendsDrawer] refreshStrip parallel-fetch failed:', err.message);
  }
  renderFriendStrip(host, connections, {
    onAddClick: openInviteFlow,
    onAvatarTap: handleAvatarTap,
    onAvatarLongPress: (conn, anchor) => handleAvatarLongPress(conn, anchor, mutedSharePubs),
    mutedSharePubs,
  });
  updateAllMutedBanner(connections, mutedSharePubs);
}

/**
 * Show the "all friends muted" banner when (a) connections > 0 and (b) every
 * connection is in the muted set. Hide it otherwise. The banner itself sits
 * in the drawer markup as a hidden div; we just toggle the `hidden` attr.
 *
 * Per FRIENDS.md: do NOT show when connections.length === 0 — that's the
 * empty state from #124, which the strip handles. The banner is exclusively
 * for the "you've muted everyone you connected with" case.
 */
function updateAllMutedBanner(connections, mutedSharePubs) {
  const banner = document.getElementById(BANNER_ID);
  if (!banner) return;
  if (!connections || connections.length === 0) {
    banner.hidden = true;
    return;
  }
  const allMuted = connections.every(c => c && c.share_pub && mutedSharePubs.has(c.share_pub));
  banner.hidden = !allMuted;
}

/**
 * Re-render the Recent finishes events region (#125). Called on drawer open.
 * Independent of strip refresh so the two regions hydrate in parallel and
 * one slow path doesn't gate the other.
 *
 * Errors are swallowed inside `hydrateRecentFinishes` (warning logged); the
 * region just stays empty in that case, which the empty-CSS rule hides.
 */
async function refreshEvents() {
  const host = document.getElementById(EVENTS_HOST_ID);
  if (!host) return;
  await hydrateRecentFinishes(host);
}

/**
 * Tap on a friend avatar → dismiss the drawer and open the friend's
 * full-screen shelf view (issue #123). Per FRIENDS.md Surface 2: closing
 * the shelf returns to the user's Library, NOT to the drawer.
 *
 * The window hook is preserved (browser tests in #122 + #123 use it as a
 * smoke-test signal that doesn't depend on console capture).
 */
function handleAvatarTap(connection) {
  if (typeof window !== 'undefined') {
    window.__bookishLastFriendTap = {
      label: connection.label || null,
      share_pub: connection.share_pub || null,
      at: Date.now(),
    };
  }
  // Close the drawer first so the shelf overlay isn't stacked on top of an
  // already-modal surface — the spec is explicit that the drawer dismisses
  // when an avatar is tapped. Lazy-import the shelf view so we don't pay
  // its weight on drawer-open if the user just glances and dismisses.
  closeFriendsDrawer();
  import('./friend-shelf-view.js').then(m => {
    m.openFriendShelfView(connection).catch(err => {
      console.warn('[Bookish:FriendsDrawer] openFriendShelfView failed:', err.message);
    });
  }).catch(err => {
    console.error('[Bookish:FriendsDrawer] friend-shelf-view import failed:', err);
  });
}

/**
 * Long-press / right-click on a friend avatar in the strip → overflow menu
 * with Mute (or Unmute) + Remove (#131). The menu is anchored to the cell
 * that triggered the gesture; the action callbacks call into the friends.js
 * SDK wrappers and then refresh the strip + events region so the UI reflects
 * the new state.
 *
 * `mutedSharePubs` is the snapshot from the last refreshStrip — the menu
 * uses it to decide whether to show "Mute" or "Unmute". After a successful
 * action, refreshStrip re-fetches both the connection list and the muted
 * set, so the snapshot only needs to be fresh enough for the menu's initial
 * render.
 */
function handleAvatarLongPress(connection, anchorEl, mutedSharePubs) {
  // Test hook + dev breadcrumb (preserved across stub→real wiring so any
  // existing browser tests / debug taps continue to observe the call).
  if (typeof window !== 'undefined') {
    window.__bookishLastFriendLongPress = {
      label: connection.label || null,
      share_pub: connection.share_pub || null,
      at: Date.now(),
    };
  }

  const label = displayNameForConnection(connection);
  const wasMuted = !!(connection.share_pub && mutedSharePubs && mutedSharePubs.has(connection.share_pub));

  openFriendOverflowMenu({
    anchor: anchorEl,
    label,
    isMuted: wasMuted,
    onMute: () => handleMute(connection, label),
    onUnmute: () => handleUnmute(connection, label),
    onRemove: () => handleRemove(connection, label),
  });
}

async function handleMute(connection, label) {
  try {
    await friends.muteConnection(connection);
  } catch (err) {
    console.warn('[Bookish:FriendsDrawer] muteConnection failed:', err.message);
    showFriendsToast(`Couldn't mute ${label}.`);
    return;
  }
  // Refresh both regions: strip needs the new "Muted" badge; events region
  // needs to drop this friend's recent finishes.
  await Promise.all([
    refreshStrip().catch(() => {}),
    refreshEvents().catch(() => {}),
  ]);
}

async function handleUnmute(connection, label) {
  try {
    await friends.unmuteConnection(connection);
  } catch (err) {
    console.warn('[Bookish:FriendsDrawer] unmuteConnection failed:', err.message);
    showFriendsToast(`Couldn't unmute ${label}.`);
    return;
  }
  await Promise.all([
    refreshStrip().catch(() => {}),
    refreshEvents().catch(() => {}),
  ]);
}

async function handleRemove(connection, label) {
  let confirmed = false;
  try {
    confirmed = await openConfirmDialog({
      title: `Remove ${label} as a friend?`,
      body: `You won't see each other's shelves or activity.`,
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
      destructive: true,
    });
  } catch {
    confirmed = false;
  }
  if (!confirmed) return;

  try {
    await friends.removeConnection(connection);
  } catch (err) {
    console.warn('[Bookish:FriendsDrawer] removeConnection failed:', err.message);
    showFriendsToast(`Couldn't remove ${label}.`);
    return;
  }
  await Promise.all([
    refreshStrip().catch(() => {}),
    refreshEvents().catch(() => {}),
  ]);
}

/**
 * Lightweight inline toast for mute / unmute / remove failures. Same shape
 * as the hide-confirmation toast above. Self-contained so the drawer
 * doesn't need to import from app.js.
 */
function showFriendsToast(message) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('bookishStatusToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'bookishStatusToast';
  toast.className = 'toast status-toast';
  toast.setAttribute('role', 'status');
  const span = document.createElement('span');
  span.className = 'toast-message';
  span.textContent = message;
  toast.appendChild(span);
  toast.style.cssText = 'position:fixed;top:calc(var(--header-height) + env(safe-area-inset-top) + 8px);left:50%;transform:translateX(-50%);z-index:9001;';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
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
  // Hydrate the Recent finishes region (#125) in parallel — Tarn read may
  // be slower than the connections list, but we don't want it gating the
  // strip paint. The region stays empty (and CSS-hidden) until the fetch
  // completes; today's reality is that it stays empty (publish-on-save
  // lands in #8).
  refreshEvents().catch(err =>
    console.warn('[Bookish:FriendsDrawer] events hydrate failed:', err.message),
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
export const _refreshEventsForTest = refreshEvents;
