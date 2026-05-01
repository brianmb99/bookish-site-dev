// friend-pip.js — Tiny avatar pip used on Library book cards (#126) and
// later on unisearch result rows (#7).
//
// The pip is a 14px circle with the friend's initial in white, painted with
// the same deterministic color as `friend-avatar.js` so Maya is the same
// teal in the drawer, on the friend's shelf header, in event rows, and on
// the pip — visual identity holds across every social surface.
//
// Why a separate component (vs. reusing `renderFriendAvatar` with a `pip`
// size variant): the pip has a load of pip-specific concerns the avatar
// doesn't carry — the "+N" overflow variant, the legibility border tuned
// for a half-on-cover/half-on-card edge-straddle position, and the click
// behavior that opens a friend-book-detail modal rather than navigating to
// a friend's shelf. Keeping pip rendering in its own module means the
// avatar component stays general and we don't grow a tangle of variant
// flags. Color + initial helpers are imported from friend-avatar.js so the
// determinism stays single-sourced.
//
// What this module does NOT do: layout. The straddling-the-cover-edge
// position is achieved by CSS (.friend-pip-overlay positioned absolutely
// against .cover with `bottom: -7px; left: 6px`). This module only paints
// the pips themselves and emits the right markup; it never measures
// anything or computes positioning.

import { avatarColorForConnection, initialForLabel } from './friend-avatar.js';
import { displayNameForConnection } from './friend-strip.js';

/**
 * Render a single 14px friend pip for a connection.
 *
 * @param {{ share_pub?: string, label?: string }} connection
 * @param {{
 *   onTap?: (connection: object, btn: HTMLElement) => void,
 *   ariaLabel?: string,
 * }} [opts]
 * @returns {HTMLElement} a <button> element ready to append to the pip overlay
 */
export function renderFriendPip(connection, opts = {}) {
  const name = displayNameForConnection(connection);
  const initial = initialForLabel(name);
  const color = avatarColorForConnection(connection);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'friend-pip';
  btn.style.backgroundColor = color;
  btn.textContent = initial;
  btn.setAttribute('aria-label', opts.ariaLabel || name || 'Friend');
  btn.dataset.sharePub = connection?.share_pub || '';

  if (typeof opts.onTap === 'function') {
    btn.addEventListener('click', (ev) => {
      // Stop the click from bubbling up to the card-level handler that opens
      // the user's own book-detail modal. Pip taps are an explicit, separate
      // affordance.
      ev.stopPropagation();
      ev.preventDefault();
      opts.onTap(connection, btn);
    });
    // Defang Enter / Space so keyboard activation on the pip never bubbles
    // into the card's keydown handler (which also opens the user's modal).
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') ev.stopPropagation();
    });
  }

  return btn;
}

/**
 * Render the "+N" overflow pip used in the third slot when more than three
 * friends match. Same dimensions and border as a regular pip so the cap
 * doesn't introduce visual jitter; a neutral background-color separates it
 * from any real friend pip color (no risk of collision because the +N pip
 * never carries an initial that matches a friend's letter).
 *
 * @param {number} overflowCount - the number HIDDEN, e.g. 4 friends → 2 pips + "+2"
 * @returns {HTMLElement}
 */
export function renderOverflowPip(overflowCount) {
  const span = document.createElement('span');
  span.className = 'friend-pip friend-pip-overflow';
  span.textContent = `+${overflowCount}`;
  span.setAttribute('aria-label', `${overflowCount} more`);
  return span;
}

/**
 * Build a pip overlay element with up to MAX_VISIBLE pips and a "+N"
 * overflow pip when there are more matching friends. Returns the wrapper
 * element ready to append to a card; returns null if there are zero matches
 * (callers should not append anything in that case to avoid an empty
 * overlay node sitting on every card).
 *
 * Cap rule (per spec):
 *   - 0 matches → null
 *   - 1-3 matches → 1-3 pips, no overflow
 *   - 4+ matches → 2 pips + "+N" pip in the third slot, where N = total - 2
 *
 * @param {Array<{ share_pub: string, label?: string }>} matchingFriends
 * @param {{
 *   onTapPip?: (connection: object, btn: HTMLElement) => void,
 * }} [opts]
 * @returns {HTMLElement | null}
 */
export function renderPipOverlay(matchingFriends, opts = {}) {
  if (!Array.isArray(matchingFriends) || matchingFriends.length === 0) return null;

  const overlay = document.createElement('div');
  overlay.className = 'friend-pip-overlay';

  const total = matchingFriends.length;
  if (total <= 3) {
    for (const conn of matchingFriends) {
      overlay.appendChild(renderFriendPip(conn, { onTap: opts.onTapPip }));
    }
  } else {
    overlay.appendChild(renderFriendPip(matchingFriends[0], { onTap: opts.onTapPip }));
    overlay.appendChild(renderFriendPip(matchingFriends[1], { onTap: opts.onTapPip }));
    overlay.appendChild(renderOverflowPip(total - 2));
  }

  return overlay;
}

// Test hook so unit tests can assert on the visible cap without re-deriving
// the rule.
export const PIP_VISIBLE_CAP = 3;
