// friend-glyph-trigger.js — Header entry point for the Friends drawer.
//
// A small, abstract "person cluster" glyph + ↗ arrow that opens the Friends
// drawer when tapped. Sized to match the existing WTR `12 ↗` button visually
// (same compact muted-text class), per FRIENDS.md Surface 1 → Entry point in
// the header.
//
// Visibility rule (#124, follow-up to #122):
//   - Visible whenever the user is logged in, regardless of friend count.
//   - Hidden only when the user has explicitly opted out via either the
//     drawer's "Hide friends from header" link or the Account → Friends
//     toggle. Preference is per-device (localStorage), not Tarn-synced.
//
// Why we no longer auto-hide at 0 friends: #122 hid the trigger when the
// connections count was zero, intending solo users to discover Friends via
// Account → "Add a friend." But #122 also removed that Account entry, which
// left brand-new users with no UI to send their first invite. The fix
// (#124) is to keep the glyph visible by default and let the empty-drawer
// state offer the prominent "+ Add" CTA.
//
// We intentionally do NOT render real friend avatars in the trigger. Per the
// FRIENDS.md anti-patterns + Surface 1 rationale, three-avatar piles in the
// header read as a notification surface and compete with `12 ↗` for visual
// weight. A small glyph at the same weight as `12 ↗` keeps the header calm
// and parallel-but-distinct (number for WTR, glyph for Friends).
//
// The trigger button DOM lives in index.html (so it ships with the initial
// HTML payload and doesn't FOUC). This module is responsible for:
//   1. Wiring the click handler to open the drawer.
//   2. Toggling the trigger's display based on the local hide preference.
//   3. Exposing a `refreshFriendGlyphTrigger()` for callers (login,
//      logout, post-accept, toggle change) to re-evaluate visibility.

import { openFriendsDrawer } from './friends-drawer.js';

const TRIGGER_ID = 'friendsHeaderBtn';

// localStorage key for the per-device "hide friends from header" preference.
// Value `'true'` means hidden; absence or any other value means visible.
// Per-device (not Tarn-synced), consistent with the first-connect education
// flag pattern referenced in FRIENDS.md.
export const FRIENDS_HIDDEN_LS_KEY = 'bookish:friends:hidden';

// Custom event broadcast when the preference changes so the trigger refreshes
// live (e.g. when the Account toggle flips it). Fired by setHideFriendsFromHeader().
export const FRIENDS_VISIBILITY_EVENT = 'bookish:friends-visibility-changed';

let _wired = false;
let _visibilityHandler = null;

function getTrigger() {
  return document.getElementById(TRIGGER_ID);
}

/**
 * Read the local "hidden" preference. Returns true when the trigger should
 * be hidden. Defaults to false (visible) on missing key, malformed value,
 * or environments without localStorage.
 *
 * @returns {boolean}
 */
export function isFriendsHiddenFromHeader() {
  try {
    return localStorage.getItem(FRIENDS_HIDDEN_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Write the local "hidden" preference. Dispatches a window-level event so
 * any subscriber (the trigger, the Account toggle) refreshes immediately.
 *
 * @param {boolean} hidden  true → hide the trigger; false → show it
 */
export function setHideFriendsFromHeader(hidden) {
  try {
    if (hidden) {
      localStorage.setItem(FRIENDS_HIDDEN_LS_KEY, 'true');
    } else {
      localStorage.removeItem(FRIENDS_HIDDEN_LS_KEY);
    }
  } catch (err) {
    console.warn('[Bookish:FriendGlyphTrigger] localStorage write failed:', err.message);
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(FRIENDS_VISIBILITY_EVENT, {
      detail: { hidden: !!hidden },
    }));
  }
}

/**
 * Wire the trigger's click handler. Idempotent — re-calling is a no-op.
 * Called once during app boot. Also subscribes to the visibility-changed
 * event so flipping the preference live (drawer link or Account toggle)
 * updates the header without a reload.
 */
export function wireFriendGlyphTrigger() {
  if (_wired) return;
  const trigger = getTrigger();
  if (!trigger) {
    // Markup is missing; nothing to wire. This shouldn't happen in
    // production but might in unit tests that load this module before
    // index.html is mounted.
    return;
  }
  trigger.addEventListener('click', () => {
    openFriendsDrawer({ returnFocusTo: trigger });
  });
  // Live refresh on preference change. Cheap; just toggles display.
  if (typeof window !== 'undefined') {
    _visibilityHandler = () => { refreshFriendGlyphTrigger(); };
    window.addEventListener(FRIENDS_VISIBILITY_EVENT, _visibilityHandler);
  }
  _wired = true;
}

/**
 * Re-evaluate the trigger's visibility based on the local hide preference.
 * Cheap; safe to call on a tick. No Tarn / network access — the friend
 * count no longer factors in (per #124).
 *
 * Returns the visible state so callers (and tests) can branch on it.
 *
 * @returns {boolean} true if the trigger is now visible
 */
export function refreshFriendGlyphTrigger() {
  const trigger = getTrigger();
  if (!trigger) return false;
  if (isFriendsHiddenFromHeader()) {
    trigger.style.display = 'none';
    trigger.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('tabindex', '-1');
    return false;
  }
  trigger.style.display = '';
  trigger.removeAttribute('aria-hidden');
  trigger.removeAttribute('tabindex');
  return true;
}

// Test hook.
export const _TRIGGER_ID = TRIGGER_ID;
