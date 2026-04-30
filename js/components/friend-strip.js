// friend-strip.js — Region B of the Friends drawer (issue #122).
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
// a no-op (with a console.log breadcrumb so dev work can confirm wiring).

import { renderFriendAvatar } from './friend-avatar.js';

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
  if (connection.email) {
    const local = connection.email.split('@')[0];
    if (local) return local;
  }
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
 *       <button class="friend-strip-add" type="button">+ Add</button>
 *     </div>
 *     <div class="friend-strip-scroll">
 *       <button class="friend-strip-cell" ...>
 *         <div class="friend-avatar" ...>M</div>
 *         <div class="friend-strip-name">Maya</div>
 *       </button>
 *       …
 *     </div>
 *   </div>
 *
 * @param {HTMLElement} container
 * @param {Array} connections
 * @param {{
 *   onAvatarTap?: (connection: object) => void,
 *   onAvatarLongPress?: (connection: object, anchor: HTMLElement) => void,
 *   onAddClick?: () => void,
 * }} [opts]
 */
export function renderFriendStrip(container, connections, opts = {}) {
  if (!container) return;

  const sorted = sortConnectionsForStrip(connections || []);

  // Empty-state branch (#124). When the user has no friends yet, swap the
  // compact strip for a friendly empty state with a prominent "+ Add" CTA.
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
          <p class="friend-strip-empty-message">No friends yet — invite someone to start.</p>
          <button class="btn primary friend-strip-empty-add" type="button" data-friend-add>+ Add</button>
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
        <button class="friend-strip-add" type="button" data-friend-add>+ Add</button>
      </div>
      <div class="friend-strip-scroll" role="list" data-friend-scroll></div>
    </div>
  `;

  const scroll = container.querySelector('[data-friend-scroll]');
  const addBtn = container.querySelector('[data-friend-add]');

  for (const conn of sorted) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'friend-strip-cell';
    cell.setAttribute('role', 'listitem');
    cell.dataset.sharePub = conn.share_pub || '';

    const name = displayNameForConnection(conn);
    cell.setAttribute('aria-label', name);

    const avatar = renderFriendAvatar(conn, { ariaLabel: name });
    cell.appendChild(avatar);

    const nameEl = document.createElement('div');
    nameEl.className = 'friend-strip-name';
    nameEl.textContent = name;
    cell.appendChild(nameEl);

    // Tap → navigation handler stub. Issue 4 wires the friend's shelf.
    cell.addEventListener('click', () => {
      if (typeof opts.onAvatarTap === 'function') {
        opts.onAvatarTap(conn);
      } else {
        // Stub breadcrumb for dev — handler arrives in issue 4.
        console.log('[Bookish:FriendStrip] tap (no handler):', name);
      }
    });

    // Long-press → overflow menu stub. Issue 10 wires Mute/Remove.
    let pressTimer = null;
    let pressed = false;
    const startPress = () => {
      pressed = false;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        pressed = true;
        if (typeof opts.onAvatarLongPress === 'function') {
          opts.onAvatarLongPress(conn, cell);
        } else {
          console.log('[Bookish:FriendStrip] long-press (no handler):', name);
        }
      }, LONG_PRESS_MS);
    };
    const cancelPress = () => {
      clearTimeout(pressTimer);
      pressTimer = null;
    };
    cell.addEventListener('touchstart', startPress, { passive: true });
    cell.addEventListener('touchmove', cancelPress, { passive: true });
    cell.addEventListener('touchend', cancelPress);
    cell.addEventListener('touchcancel', cancelPress);
    cell.addEventListener('mousedown', startPress);
    cell.addEventListener('mouseup', cancelPress);
    cell.addEventListener('mouseleave', cancelPress);
    // Right-click → also surface overflow on desktop (parity with long-press).
    cell.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancelPress();
      if (typeof opts.onAvatarLongPress === 'function') {
        opts.onAvatarLongPress(conn, cell);
      } else {
        console.log('[Bookish:FriendStrip] context menu (no handler):', name);
      }
    });
    // If long-press fired, suppress the click-tap that would otherwise follow.
    cell.addEventListener('click', (e) => {
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

// Re-export displayNameForConnection from one place so callers can use it
// without depending on this module if they only need the helper.
export { escapeHtml as _escapeHtmlForTest };
