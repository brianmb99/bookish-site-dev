// friend-glyph-trigger.js — Header entry point for the Friends drawer (issue #122).
//
// A small, abstract "person cluster" glyph + ↗ arrow that opens the Friends
// drawer when tapped. Sized to match the existing WTR `12 ↗` button visually
// (same compact muted-text class), per FRIENDS.md Surface 1 → Entry point in
// the header.
//
// Visibility rule (mirrors WTR):
//   - Hidden when the user has zero connections.
//   - Shown when ≥1 connection exists.
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
//   2. Toggling the trigger's display based on the connections count.
//   3. Exposing a `refreshFriendGlyphTrigger()` for callers (login,
//      logout, post-accept) to re-evaluate visibility.

import * as friends from '../core/friends.js';
import { openFriendsDrawer } from './friends-drawer.js';

const TRIGGER_ID = 'friendsHeaderBtn';

let _wired = false;

function getTrigger() {
  return document.getElementById(TRIGGER_ID);
}

/**
 * Wire the trigger's click handler. Idempotent — re-calling is a no-op.
 * Called once during app boot.
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
  _wired = true;
}

/**
 * Re-evaluate the trigger's visibility based on the current connections
 * count. Cheap; safe to call on a tick.
 *
 * Returns the visible state so callers (and tests) can branch on it.
 *
 * @returns {Promise<boolean>} true if the trigger is now visible
 */
export async function refreshFriendGlyphTrigger() {
  const trigger = getTrigger();
  if (!trigger) return false;
  let count = 0;
  try {
    const connections = await friends.listConnections();
    count = Array.isArray(connections) ? connections.length : 0;
  } catch (err) {
    console.warn('[Bookish:FriendGlyphTrigger] listConnections failed:', err.message);
    // On error, hide rather than show — stale visibility is worse than
    // a missing entry point. The user can still get to invite via Account.
    count = 0;
  }
  if (count >= 1) {
    trigger.style.display = '';
    trigger.removeAttribute('aria-hidden');
    trigger.removeAttribute('tabindex');
    return true;
  }
  trigger.style.display = 'none';
  trigger.setAttribute('aria-hidden', 'true');
  trigger.setAttribute('tabindex', '-1');
  return false;
}

// Test hook.
export const _TRIGGER_ID = TRIGGER_ID;
