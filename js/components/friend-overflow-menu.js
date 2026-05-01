// friend-overflow-menu.js — Mute / Unmute / Remove popover for a friend
// (issue #131, FRIENDS.md Surface 1 Region B → "long-press / overflow menu").
//
// The menu is anchored to the friend cell that triggered it (long-press on
// touch, right-click / context-menu on desktop). It owns its own DOM
// lifecycle, dismiss-on-outside-click, ESC handling, and basic positioning.
//
// State ownership: the menu has no persistent state — each open call
// rebuilds the popover from scratch, computing label / handlers from the
// arguments. The drawer-side caller is responsible for refreshing the strip
// + events + match cache after a successful mute / unmute / remove (we
// surface the result via the action callback so the caller can decide
// what to repaint).
//
// Why a custom popover rather than a native context menu: long-press on
// touch can't summon a native context menu reliably across browsers, and
// the menu needs to look the same on touch + desktop for visual consistency.
// Keeping the surface tiny means we don't need to import a popover library.

const MENU_ID = 'friendOverflowMenu';
const BACKDROP_ID = 'friendOverflowBackdrop';

let _isOpen = false;
let _keydownHandler = null;
let _resizeHandler = null;
let _focusReturnEl = null;

function ensureClosed() {
  if (!_isOpen) return;
  const menu = document.getElementById(MENU_ID);
  const backdrop = document.getElementById(BACKDROP_ID);
  if (menu) menu.remove();
  if (backdrop) backdrop.remove();
  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = null;
  }
  if (_resizeHandler) {
    window.removeEventListener('resize', _resizeHandler);
    _resizeHandler = null;
  }
  _isOpen = false;
  if (_focusReturnEl && typeof _focusReturnEl.focus === 'function') {
    try { _focusReturnEl.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  _focusReturnEl = null;
}

/**
 * Position the menu near the anchor element, clamping to the viewport.
 * Uses fixed positioning so scroll on the underlying content (the drawer's
 * strip) doesn't shift the menu out of place.
 */
function positionMenu(menu, anchor) {
  if (!menu || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;
  // Prefer below the anchor; flip above if it'd overflow.
  let top = rect.bottom + 4;
  if (top + menuRect.height + margin > window.innerHeight) {
    top = Math.max(margin, rect.top - menuRect.height - 4);
  }
  // Prefer left-aligned with the anchor; clamp to viewport on the right.
  let left = rect.left;
  if (left + menuRect.width + margin > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - menuRect.width - margin);
  }
  if (left < margin) left = margin;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
}

/**
 * Open the friend overflow menu anchored to `anchor`. Idempotent — calling
 * while open closes the existing menu first.
 *
 * @param {{
 *   anchor: HTMLElement,
 *   label: string,
 *   isMuted: boolean,
 *   onMute?: () => void,
 *   onUnmute?: () => void,
 *   onRemove?: () => void,
 * }} args
 */
export function openFriendOverflowMenu(args) {
  if (!args || !args.anchor) return;
  ensureClosed();
  _focusReturnEl = args.anchor;

  // Backdrop catches outside clicks. Transparent — the menu should feel
  // anchored to the strip, not modal. Pointer events on, but no dimming.
  const backdrop = document.createElement('div');
  backdrop.id = BACKDROP_ID;
  backdrop.className = 'friend-overflow-backdrop';
  backdrop.addEventListener('click', () => ensureClosed());
  // Right-click on backdrop also dismisses (desktop affordance).
  backdrop.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ensureClosed();
  });

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'friend-overflow-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `Actions for ${args.label || 'friend'}`);

  const muteLabel = args.isMuted ? 'Unmute' : 'Mute';
  const muteHandler = args.isMuted ? args.onUnmute : args.onMute;
  menu.innerHTML = `
    <button type="button" class="friend-overflow-item" role="menuitem" data-action="mute">
      ${muteLabel}
    </button>
    <button type="button" class="friend-overflow-item friend-overflow-item-danger" role="menuitem" data-action="remove">
      Remove…
    </button>
  `;

  // Wire actions. The menu closes synchronously before invoking the handler
  // so the caller's confirm dialog / toast renders against a clean DOM.
  const muteBtn = menu.querySelector('[data-action="mute"]');
  const removeBtn = menu.querySelector('[data-action="remove"]');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      ensureClosed();
      if (typeof muteHandler === 'function') muteHandler();
    });
  }
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      ensureClosed();
      if (typeof args.onRemove === 'function') args.onRemove();
    });
  }

  document.body.appendChild(backdrop);
  document.body.appendChild(menu);
  _isOpen = true;

  // Position after appending so getBoundingClientRect has real dimensions.
  positionMenu(menu, args.anchor);

  // ESC closes; resize re-positions (cheap reflow on phone rotation, etc.).
  _keydownHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      ensureClosed();
    }
  };
  _resizeHandler = () => positionMenu(menu, args.anchor);
  document.addEventListener('keydown', _keydownHandler);
  window.addEventListener('resize', _resizeHandler);

  // Initial focus on the first menu item so keyboard users can navigate.
  requestAnimationFrame(() => {
    if (muteBtn) muteBtn.focus({ preventScroll: true });
  });
}

/**
 * Close the overflow menu. Safe to call when not open.
 */
export function closeFriendOverflowMenu() {
  ensureClosed();
}

/**
 * Whether the overflow menu is currently open. Test hook + caller-side
 * guard.
 */
export function isFriendOverflowMenuOpen() { return _isOpen; }
