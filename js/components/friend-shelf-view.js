// friend-shelf-view.js — Surface 2 of the Friends feature (issue #123).
//
// A full-screen, read-only mirror of the Library grid for someone else's
// books. Same card markup as the user's own Library (consumed from the
// shared book-card.js builders); different chrome (header is the friend's
// name + avatar, no +Add button, no edit affordances).
//
// Lifecycle:
//
//   openFriendShelfView(connection)
//     → builds DOM if not yet present
//     → fills the header with friend's avatar + label
//     → shows skeleton cards in the grid
//     → calls friends.fetchFriendLibrary(connection)
//     → on success: renders cards (or empty state)
//     → on failure: renders error state with [Retry]
//     → wires close → returns to user's Library (NOT to the drawer)
//
//   closeFriendShelfView()
//     → hides the overlay, pops the overlay-history state
//
// State ownership: this module owns its own DOM lifecycle, the in-flight
// fetch (so close-while-loading is safe), and the focus-return target
// (the friend strip cell, or document.body if the drawer was already
// closed by the time we mounted).
//
// Per FRIENDS.md Surface 2: closing the view returns to Library, NOT to
// the drawer. Visiting another friend requires re-opening the drawer
// (one extra tap). This friction is intentional.

import * as friends from '../core/friends.js';
import { buildCardHTML } from './book-card.js';
import { renderFriendAvatar } from './friend-avatar.js';
import { displayNameForConnection } from './friend-strip.js';
import { READING_STATUS, normalizeReadingStatus } from '../core/book_repository.js';
import { pushOverlayState, popOverlayState } from '../core/overlay_history.js';

const OVERLAY_ID = 'friendShelfOverlay';
const HEADER_AVATAR_ID = 'friendShelfHeaderAvatar';
const HEADER_NAME_ID = 'friendShelfHeaderName';
const HEADER_MUTED_ID = 'friendShelfHeaderMuted';
const CARDS_ID = 'friendShelfCards';
const CLOSE_ID = 'friendShelfClose';
const MUTE_BTN_ID = 'friendShelfMute';
const STATE_HOST_ID = 'friendShelfState';

let _isOpen = false;
let _focusReturnEl = null;
let _keydownHandler = null;
let _currentConnection = null;
// Token bumped per open/retry; in-flight fetches check it before painting
// to avoid stale results overwriting a fresher one.
let _fetchToken = 0;

function ensureMarkup() {
  if (document.getElementById(OVERLAY_ID)) return;
  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  root.className = 'friend-shelf-overlay';
  root.style.display = 'none';
  // Markup: header (avatar + name + Mute button + close) above the cards
  // grid. The grid uses the same `.cards` class as the Library so the
  // existing CSS layout rules apply verbatim. The state host sits inside
  // the cards container so loading / empty / error replace the grid in
  // place — same pattern the Library uses for its own empty + skeleton.
  root.innerHTML = `
    <div class="friend-shelf-chrome" role="dialog" aria-modal="true" aria-labelledby="friendShelfTitle">
      <header class="friend-shelf-header">
        <div class="friend-shelf-identity">
          <div class="friend-shelf-avatar-host" id="${HEADER_AVATAR_ID}"></div>
          <div class="friend-shelf-name-block">
            <div class="friend-shelf-name-row">
              <div class="friend-shelf-name" id="${HEADER_NAME_ID}" tabindex="-1"></div>
              <span class="friend-shelf-muted-indicator" id="${HEADER_MUTED_ID}" hidden>Muted</span>
            </div>
            <div class="friend-shelf-name-sub">Their library</div>
          </div>
        </div>
        <div class="friend-shelf-actions">
          <button type="button" class="friend-shelf-mute" id="${MUTE_BTN_ID}"
                  aria-label="Mute — stop seeing their activity"
                  title="Mute — stop seeing their activity">Mute</button>
          <button type="button" class="modal-close-btn" id="${CLOSE_ID}" aria-label="Close">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
            </svg>
          </button>
        </div>
      </header>
      <h1 id="friendShelfTitle" class="sr-only">Friend's shelf</h1>
      <main class="friend-shelf-body">
        <div id="${CARDS_ID}" class="cards friend-shelf-cards" aria-live="polite"></div>
        <div id="${STATE_HOST_ID}" class="friend-shelf-state" hidden></div>
      </main>
    </div>
  `;
  document.body.appendChild(root);

  document.getElementById(CLOSE_ID).addEventListener('click', () => closeFriendShelfView());

  // Mute / Unmute (#131): toggle the friend's muted state via the SDK,
  // refresh the header treatment in place. Disabled while in flight to
  // suppress double-clicks.
  document.getElementById(MUTE_BTN_ID).addEventListener('click', handleMuteButtonClick);
}

let _muteInFlight = false;

async function handleMuteButtonClick() {
  if (_muteInFlight || !_currentConnection) return;
  const btn = document.getElementById(MUTE_BTN_ID);
  if (!btn) return;
  _muteInFlight = true;
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  try {
    const wasMuted = await friends.isMuted(_currentConnection);
    if (wasMuted) {
      await friends.unmuteConnection(_currentConnection);
    } else {
      await friends.muteConnection(_currentConnection);
    }
    // Test hook for browser smoke tests.
    if (typeof window !== 'undefined') {
      window.__bookishLastFriendShelfMute = {
        share_pub: _currentConnection?.share_pub || null,
        muted: !wasMuted,
        at: Date.now(),
      };
    }
    await refreshMuteState();
  } catch (err) {
    console.warn('[Bookish:FriendShelfView] mute toggle failed:', err.message);
    showMuteErrorToast();
  } finally {
    _muteInFlight = false;
    if (btn) btn.disabled = prevDisabled;
  }
}

function showMuteErrorToast() {
  const existing = document.querySelector('.friend-shelf-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'friend-shelf-toast';
  toast.setAttribute('role', 'status');
  toast.textContent = "Couldn't update mute. Try again.";
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 250);
  }, 3000);
}

/**
 * Refresh the Mute/Unmute button label + the small "Muted" header indicator
 * to reflect the friend's current muted state. Called on open and after
 * each mute toggle.
 */
async function refreshMuteState() {
  if (!_currentConnection) return;
  const muted = await friends.isMuted(_currentConnection);
  const btn = document.getElementById(MUTE_BTN_ID);
  const indicator = document.getElementById(HEADER_MUTED_ID);
  if (btn) {
    btn.textContent = muted ? 'Unmute' : 'Mute';
    const aria = muted
      ? 'Unmute — start seeing their activity again'
      : 'Mute — stop seeing their activity';
    btn.setAttribute('aria-label', aria);
    btn.setAttribute('title', aria);
    btn.classList.toggle('friend-shelf-mute-active', muted);
  }
  if (indicator) indicator.hidden = !muted;
}

function setHeader(connection) {
  const name = displayNameForConnection(connection);
  const nameEl = document.getElementById(HEADER_NAME_ID);
  const avatarHost = document.getElementById(HEADER_AVATAR_ID);
  if (nameEl) nameEl.textContent = name;
  if (avatarHost) {
    avatarHost.replaceChildren(renderFriendAvatar(connection, { ariaLabel: name }));
  }
}

function showState(html) {
  const cards = document.getElementById(CARDS_ID);
  const state = document.getElementById(STATE_HOST_ID);
  if (!cards || !state) return;
  cards.replaceChildren();
  state.hidden = false;
  state.innerHTML = html;
}

function clearState() {
  const state = document.getElementById(STATE_HOST_ID);
  if (state) {
    state.hidden = true;
    state.innerHTML = '';
  }
}

function showSkeletons(count = 6) {
  // Same skeleton markup as the Library so the friend's-shelf loading
  // state visually matches what the user sees on their own shelf cold-load.
  const cards = document.getElementById(CARDS_ID);
  if (!cards) return;
  clearState();
  cards.innerHTML = Array(count).fill(
    '<div class="card-skeleton"><div class="skel-cover"></div><div class="skel-meta"><div class="skel-line skel-title"></div><div class="skel-line skel-author"></div><div class="skel-line skel-detail"></div></div></div>',
  ).join('');
}

/**
 * Sort entries the same way the Library does for the main grid:
 * currently-reading first (most-recently-started first), then read
 * (most-recent dateRead first). Unlike the user's own Library this
 * deliberately omits Want-to-Read — friends' WTR is intentionally not
 * a public surface (per FRIENDS.md spec).
 */
function sortFriendEntries(entries) {
  const reading = entries.filter(e => normalizeReadingStatus(e) === READING_STATUS.READING);
  const read = entries.filter(e => normalizeReadingStatus(e) === READING_STATUS.READ);
  reading.sort((a, b) => (b.readingStartedAt || b.createdAt || 0) - (a.readingStartedAt || a.createdAt || 0));
  read.sort((a, b) => {
    const da = a.dateRead || 0; const db = b.dateRead || 0;
    if (da !== db) return db - da;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  return [...reading, ...read];
}

/**
 * Render the cards grid for a list of friend entries. Pure function over
 * the DOM — assumes ensureMarkup() has run.
 *
 * Read-only render: no click handlers, no openModalWithHero wire-up. The
 * cards are visually identical to the user's own (so the `◐`
 * currently-reading accent inherits from the existing CSS keyed off
 * `data-reading="true"`) but cannot be edited or opened. Issue 6 may
 * later add a friend's-book-detail modal on tap; this issue intentionally
 * leaves the cards as inert visuals so we don't ship a half-built tap
 * behavior.
 */
export function renderFriendShelfCards(entries) {
  const cards = document.getElementById(CARDS_ID);
  if (!cards) return;
  clearState();
  if (!entries || entries.length === 0) {
    showState(emptyStateHtml());
    return;
  }
  const sorted = sortFriendEntries(entries);
  const html = sorted.map(e => {
    const isReading = normalizeReadingStatus(e) === READING_STATUS.READING;
    const rawFmt = (e.format || '').toLowerCase();
    const fmtVariant = rawFmt === 'audiobook' ? 'audio' : (rawFmt === 'ebook' ? 'ebook' : 'print');
    const ariaLabel = (e.title || 'Untitled') + (e.author ? ` by ${e.author}` : '');
    // Card wrapper carries the same dataset attributes the Library render
    // sets, so the existing CSS reading-accent and format-variant rules
    // apply unchanged. role="img" not "button" — read-only cards are
    // not focusable buttons because they have no activation behavior.
    const datasetAttrs =
      `data-fmt="${escapeAttr(fmtVariant)}"` +
      ` data-format="${escapeAttr(rawFmt)}"` +
      (isReading ? ' data-reading="true"' : '') +
      ` data-friend-card="true"`;
    return `<div class="card friend-shelf-card" ${datasetAttrs} aria-label="${escapeAttr(ariaLabel)}" role="img">${buildCardHTML(e, false)}</div>`;
  }).join('');
  cards.innerHTML = html;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function emptyStateHtml() {
  const name = displayNameForConnection(_currentConnection);
  return `
    <div class="friend-shelf-empty">
      <div class="friend-shelf-empty-icon" aria-hidden="true">📚</div>
      <div class="friend-shelf-empty-headline">${escapeAttr(name)} hasn't added books yet.</div>
      <div class="friend-shelf-empty-sub">When they do, you'll see them here.</div>
    </div>
  `;
}

function errorStateHtml() {
  const name = displayNameForConnection(_currentConnection);
  return `
    <div class="friend-shelf-error">
      <div class="friend-shelf-error-icon" aria-hidden="true">⚠️</div>
      <div class="friend-shelf-error-headline">Couldn't load ${escapeAttr(name)}'s shelf.</div>
      <button type="button" class="friend-shelf-retry" id="friendShelfRetry">Retry</button>
    </div>
  `;
}

async function loadAndRender(connection) {
  const myToken = ++_fetchToken;
  showSkeletons(6);
  let entries = null;
  let failed = false;
  try {
    entries = await friends.fetchFriendLibrary(connection);
  } catch (err) {
    console.warn('[Bookish:FriendShelfView] fetchFriendLibrary failed:', err.message);
    failed = true;
  }
  // If the user closed or navigated to a different friend in the meantime,
  // discard this paint so the fresher fetch wins.
  if (myToken !== _fetchToken) return;
  if (failed) {
    showState(errorStateHtml());
    const retry = document.getElementById('friendShelfRetry');
    if (retry) retry.addEventListener('click', () => loadAndRender(connection));
    return;
  }
  renderFriendShelfCards(entries || []);
}

function trapFocusKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFriendShelfView();
    return;
  }
  if (e.key !== 'Tab') return;
  const root = document.getElementById(OVERLAY_ID);
  if (!root) return;
  const focusables = root.querySelectorAll(
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
 * Open the friend's-shelf full-screen view for the given connection.
 * Idempotent — if already open for the same friend, no-op. If open for a
 * different friend, swaps the header and re-fetches.
 *
 * @param {{ share_pub: string, signing_pub: string, label?: string|null }} connection
 * @param {{ returnFocusTo?: HTMLElement | null }} [opts]
 */
export async function openFriendShelfView(connection, opts = {}) {
  if (!connection) return;
  ensureMarkup();
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;

  // Track the focus-return target. Per spec, closing the friend's-shelf
  // returns to the *Library*, not to the drawer — so we don't try to
  // restore focus to the drawer cell. We park focus on document.body
  // (or the user-supplied returnFocusTo) which keyboard users can then
  // tab from to reach the rest of the Library chrome.
  if (!_isOpen) {
    _focusReturnEl = opts.returnFocusTo || null;
  }

  const sameConnection = _currentConnection && _currentConnection.share_pub === connection.share_pub;
  _currentConnection = connection;
  setHeader(connection);

  if (!_isOpen) {
    overlay.style.display = 'block';
    document.body.classList.add('modal-open');
    _isOpen = true;
    pushOverlayState('friend-shelf');
    _keydownHandler = trapFocusKeydown;
    document.addEventListener('keydown', _keydownHandler);
    requestAnimationFrame(() => {
      const close = document.getElementById(CLOSE_ID);
      if (close) close.focus({ preventScroll: true });
    });
  }

  if (!sameConnection || !_isOpen) {
    // Kick off both the library load and the mute-state probe in parallel.
    // Mute state is a tiny SDK call; library may take a beat. We don't
    // gate the library render on the mute fetch — they update independent
    // header / cards regions.
    refreshMuteState().catch(err =>
      console.warn('[Bookish:FriendShelfView] refreshMuteState failed:', err.message),
    );
    await loadAndRender(connection);
  }
}

/**
 * Close the friend's-shelf view. Safe to call when not open.
 *
 * @param {boolean} [fromPopstate]
 */
export function closeFriendShelfView(fromPopstate = false) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) { _isOpen = false; return; }
  overlay.style.display = 'none';
  document.body.classList.remove('modal-open');
  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = null;
  }
  if (_isOpen && !fromPopstate) popOverlayState();
  _isOpen = false;
  _currentConnection = null;
  // Bump the fetch token so any in-flight loadAndRender skips its paint.
  _fetchToken++;

  if (_focusReturnEl && typeof _focusReturnEl.focus === 'function') {
    try { _focusReturnEl.focus({ preventScroll: true }); } catch { /* ignore */ }
  } else {
    // Per spec we return to Library on close. Park focus on body so the
    // user can tab to the next interactive Library affordance.
    try { document.body.focus?.(); } catch { /* ignore */ }
  }
  _focusReturnEl = null;
}

export function isFriendShelfViewOpen() { return _isOpen; }

// Test hooks
export const _renderFriendShelfCardsForTest = renderFriendShelfCards;
export const _loadAndRenderForTest = loadAndRender;
export const _refreshMuteStateForTest = refreshMuteState;
export const _handleMuteButtonClickForTest = handleMuteButtonClick;
