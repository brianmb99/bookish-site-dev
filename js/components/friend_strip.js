// friend_strip.js — Region B of the Friends drawer (issue #122).
//
// Horizontal scrollable row of friend avatars + display names. This is the
// "friends-as-launcher" surface from FRIENDS.md (Surface 1, Region B).
//
// The strip itself is a leaf renderer; it does not own a connections fetch.
// Callers (the drawer) pass in the already-loaded connections array, which
// keeps state ownership clear and makes testing trivial. The strip emits
// behavior via the callbacks in `opts`:
//
//   onAvatarTap(connection)     — open the friend's shelf (issue 4 will wire)
//   onAvatarLongPress(connection) — overflow menu: Mute / Remove (issue 10)
//   onAddClick()                — open the existing invite modal
//
// All callbacks are optional; if omitted, the corresponding interaction is
// a no-op (with a debug breadcrumb so dev work can confirm wiring).

import { renderFriendAvatar } from './friend_avatar.js';
import { debugLog } from '../core/debug_log.js';

const LONG_PRESS_MS = 500;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * Order connections for the strip. Per FRIENDS.md acceptance criterion 5
 * we pick a stable order; the spec lets us choose between most-recently-
 * active-first or alphabetical. We pick **most recently established first**
 * because it answers the most common "where's the friend I just added?"
 * question without needing activity data (which doesn't ship until issue 5).
 *
 * Stable secondary sort on share_pub keeps order deterministic when two
 * connections were established at the same millisecond (won't happen in
 * practice but tests appreciate it).
 *
 * @param {Array} connections
 * @returns {Array} new sorted array
 */
export function sortConnectionsForStrip(connections) {
  return [...connections].sort((a, b) => {
    const ea = a.established_at || 0;
    const eb = b.established_at || 0;
    if (ea !== eb) return eb - ea;
    return (a.share_pub || '').localeCompare(b.share_pub || '');
  });
}

/**
 * Resolve the display name for a connection. Falls back through:
 *   label → email local-part → first 8 chars of share_pub → 'Friend'.
 * The drawer + strip use this exclusively so the rules are consistent.
 *
 * @param {{ label?: string, email?: string, share_pub?: string }} connection
 * @returns {string}
 */
export function displayNameForConnection(connection) {
  if (!connection) return 'Friend';
  const label = (connection.label || '').trim();
  if (label) return label;
  // Privacy: NEVER surface the peer's email/username as a display name. The
  // inviter names the friend at invite time (required) and can Rename later,
  // so a label is normally always present. Until one exists, fall back to a
  // short, non-PII share-pub prefix, then a generic label.
  if (connection.share_pub) return connection.share_pub.slice(0, 8);
  return 'Friend';
}

/**
 * Render the strip into the given container. Replaces the container's
 * existing children. Wires up tap, long-press, keyboard, and the +Add
 * button.
 *
 * Markup shape:
 *   <div class="friend-strip-section">
 *     <div class="friend-strip-header">
 *       <span class="friend-strip-heading">Your circle</span>
 *       <button class="friend-strip-add" type="button">Invite</button>
 *     </div>
 *     <div class="friend-strip-scroll">
 *       <button class="friend-strip-cell" ...>
 *         <div class="friend-avatar" ...>M</div>
 *         <div class="friend-strip-name">Maya</div>
 *         (when muted) <div class="friend-strip-muted">Muted</div>
 *       </button>
 *       …
 *     </div>
 *   </div>
 *
 * Muted friends render with a small "Muted" badge under the name and a
 * `data-muted="true"` dataset attribute so CSS can desaturate the avatar.
 * They remain in the strip and tappable per FRIENDS.md (visiting their
 * shelf still works; only their *signal* is suppressed elsewhere).
 *
 * @param {HTMLElement} container
 * @param {Array} connections
 * @param {{
 *   onAvatarTap?: (connection: object) => void,
 *   onAvatarLongPress?: (connection: object, anchor: HTMLElement) => void,
 *   onAddClick?: () => void,
 *   mutedSharePubs?: Set<string>,
 * }} [opts]
 */
export function renderFriendStrip(container, connections, opts = {}) {
  if (!container) return;

  const sorted = sortConnectionsForStrip(connections || []);

  // Empty-state branch (#124). When the user has no friends yet, swap the
  // compact strip for a friendly empty state with a prominent Invite CTA.
  // This is now reachable because the header glyph is always visible (the
  // 0-friends auto-hide was removed in #124), so opening the drawer with
  // zero connections is a valid first-run path. The empty state keeps the
  // section heading "Your circle" so the drawer's structural layout stays
  // recognizable across states.
  if (sorted.length === 0) {
    container.innerHTML = `
      <div class="friend-strip-section friend-strip-section-empty">
        <div class="friend-strip-header">
          <span class="friend-strip-heading">Your circle</span>
        </div>
        <div class="friend-strip-empty">
          <p class="friend-strip-empty-message">No friends yet. Invite someone to start.</p>
          <button class="btn secondary friend-strip-empty-add" type="button" data-friend-add>Invite a friend</button>
        </div>
      </div>
    `;
    const addBtn = container.querySelector('[data-friend-add]');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (typeof opts.onAddClick === 'function') opts.onAddClick();
      });
    }
    return;
  }

  // Build a stable scaffold first so the +Add button always exists alongside
  // the populated strip.
  container.innerHTML = `
    <div class="friend-strip-section">
      <div class="friend-strip-header">
        <span class="friend-strip-heading">Your circle</span>
        <button class="friend-strip-add" type="button" data-friend-add>Invite</button>
      </div>
      <div class="friend-strip-scroll" role="list" data-friend-scroll></div>
    </div>
  `;

  const scroll = container.querySelector('[data-friend-scroll]');
  const addBtn = container.querySelector('[data-friend-add]');

  // Normalize muted set so callers can pass an array, Set, or omit entirely.
  const mutedSet = opts.mutedSharePubs instanceof Set
    ? opts.mutedSharePubs
    : new Set(Array.isArray(opts.mutedSharePubs) ? opts.mutedSharePubs : []);

  for (const conn of sorted) {
    // The cell is a CONTAINER (not a button) so it can hold two real buttons:
    // the main avatar+name tap target AND a visible "⋯" overflow trigger. A
    // button can't legally contain another button, hence the restructure.
    const cell = document.createElement('div');
    cell.className = 'friend-strip-cell';
    cell.setAttribute('role', 'listitem');
    cell.dataset.sharePub = conn.share_pub || '';

    const isMuted = !!(conn.share_pub && mutedSet.has(conn.share_pub));
    if (isMuted) {
      cell.dataset.muted = 'true';
      cell.classList.add('friend-strip-cell-muted');
    }

    const name = displayNameForConnection(conn);

    const openMenu = (anchorEl) => {
      if (typeof opts.onAvatarLongPress === 'function') {
        opts.onAvatarLongPress(conn, anchorEl);
      } else {
        debugLog('[Bookish:FriendStrip] overflow (no handler):', name);
      }
    };

    // Main tap target: avatar + name (+ muted badge). Tap → friend's shelf.
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'friend-strip-cell-main';
    main.setAttribute('aria-label', isMuted ? `${name}, muted` : name);

    const avatar = renderFriendAvatar(conn, { ariaLabel: name });
    main.appendChild(avatar);

    const nameEl = document.createElement('div');
    nameEl.className = 'friend-strip-name';
    nameEl.textContent = name;
    main.appendChild(nameEl);

    if (isMuted) {
      const badge = document.createElement('div');
      badge.className = 'friend-strip-muted';
      badge.textContent = 'Muted';
      main.appendChild(badge);
    }

    cell.appendChild(main);

    // Visible overflow trigger — the discoverable way to Rename / Mute / Remove
    // (the long-press / right-click gestures below still work as shortcuts).
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'friend-strip-more';
    more.setAttribute('aria-label', `More options for ${name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.textContent = '⋯';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(more);
    });
    cell.appendChild(more);

    // Tap on the main cell → friend's shelf.
    main.addEventListener('click', () => {
      if (typeof opts.onAvatarTap === 'function') {
        opts.onAvatarTap(conn);
      } else {
        // Stub breadcrumb for dev.
        debugLog('[Bookish:FriendStrip] tap (no handler):', name);
      }
    });

    // Long-press (touch) / right-click (desktop) on the main cell → same menu.
    let pressTimer = null;
    let pressed = false;
    const startPress = () => {
      pressed = false;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        pressed = true;
        openMenu(cell);
      }, LONG_PRESS_MS);
    };
    const cancelPress = () => {
      clearTimeout(pressTimer);
      pressTimer = null;
    };
    main.addEventListener('touchstart', startPress, { passive: true });
    main.addEventListener('touchmove', cancelPress, { passive: true });
    main.addEventListener('touchend', cancelPress);
    main.addEventListener('touchcancel', cancelPress);
    main.addEventListener('mousedown', startPress);
    main.addEventListener('mouseup', cancelPress);
    main.addEventListener('mouseleave', cancelPress);
    main.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancelPress();
      openMenu(cell);
    });
    // If long-press fired, suppress the click-tap that would otherwise follow.
    main.addEventListener('click', (e) => {
      if (pressed) {
        e.stopPropagation();
        e.preventDefault();
        pressed = false;
      }
    }, true);

    scroll.appendChild(cell);
  }

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (typeof opts.onAddClick === 'function') opts.onAddClick();
    });
  }
}

/**
 * Synchronous skeleton for the strip, painted on drawer open BEFORE the
 * async connections fetch resolves. Mirrors the populated scaffold's
 * geometry (same header, same 64px cells) so the real render swaps in
 * without a layout shift — the drawer-flicker fix.
 *
 * @param {HTMLElement} container
 * @param {number} count - last-known connection count (cached by the
 *   drawer); 0/unknown renders just the header scaffold.
 */
export function renderFriendStripSkeleton(container, count) {
  if (!container) return;
  const n = Math.max(0, Math.min(Number(count) || 0, 12));
  const cells = Array.from({ length: n }, () => `
    <div class="friend-strip-cell friend-strip-skeleton-cell" aria-hidden="true">
      <div class="friend-avatar friend-strip-skeleton-avatar"></div>
      <div class="friend-strip-name friend-strip-skeleton-name"></div>
    </div>`).join('');
  container.innerHTML = `
    <div class="friend-strip-section" data-friend-strip-skeleton>
      <div class="friend-strip-header">
        <span class="friend-strip-heading">Your circle</span>
        ${n > 0 ? '<button class="friend-strip-add" type="button" disabled>Invite</button>' : ''}
      </div>
      <div class="friend-strip-scroll" aria-hidden="true">${cells}</div>
    </div>
  `;
}

// Re-export displayNameForConnection from one place so callers can use it
// without depending on this module if they only need the helper.
export { escapeHtml as _escapeHtmlForTest };
