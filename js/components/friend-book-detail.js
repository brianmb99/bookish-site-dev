// friend-book-detail.js — Read-only modal showing a friend's copy of a book.
//
// Used by issue #125 (Recent finishes events: tap a row → open this modal).
// Designed to be reused by issue #6 (Library card friend-pip taps) and issue
// #7 (unisearch friend-pip taps), per FRIENDS.md Surface 5.
//
// Why a separate modal, not the existing `openModal` from app.js: the user's
// own book-detail modal is a write-mode form (textareas, status pills, save
// button, edit affordances) deeply coupled to the user's own Library and
// repository. A friend's copy is read-only by definition — no edit, no save,
// no privacy toggle, no autosave. Forking the existing modal to add a
// read-only branch would cost more in conditionals than implementing the
// minimal read-only surface here, especially since this view will be
// extended over time with friend-specific signals (their rating, their
// notes when those land).
//
// What this issue ships:
//   - Cover (or generated placeholder when no cover bytes)
//   - Title + author
//   - Friend's name + avatar (attribution: "From Maya's shelf")
//   - "Finished {Mon YYYY}" line (when readingStatus is Read + dateRead is set)
//   - Currently-reading line ("Currently reading" with the ◐ accent) when
//     the friend's record carries that status
//   - Close button + ESC + overlay-history wiring
//
// What this issue does NOT ship (deferred to future Friends issues):
//   - Friend's rating display (no rating data yet on share-log records — those
//     fields exist in the schema but the display surface lands when there's
//     real data to show)
//   - Friend's notes (notes are still a single-player field; sharing not gated)

import { escapeHtml, generatedCoverColor } from './book-card.js';
import { renderFriendAvatar } from './friend-avatar.js';
import { displayNameForConnection } from './friend-strip.js';
import { formatMonthYearDisplay } from '../core/id_core.js';
import { READING_STATUS, normalizeReadingStatus } from '../core/book_repository.js';
import { pushOverlayState, popOverlayState } from '../core/overlay_history.js';

const OVERLAY_ID = 'friendBookDetailOverlay';
const CLOSE_ID = 'friendBookDetailClose';
const COVER_ID = 'friendBookDetailCover';
const TITLE_ID = 'friendBookDetailTitle';
const AUTHOR_ID = 'friendBookDetailAuthor';
const ATTRIBUTION_ID = 'friendBookDetailAttribution';
const STATUS_ID = 'friendBookDetailStatus';

let _isOpen = false;
let _focusReturnEl = null;
let _keydownHandler = null;

function ensureMarkup() {
  if (document.getElementById(OVERLAY_ID)) return;
  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  root.className = 'friend-book-detail-overlay';
  root.style.display = 'none';
  // Single backdrop + centered card. The card is ~min(420px, 92vw); on
  // mobile it sits as a bottom sheet (CSS handles the responsive switch).
  // Read-only, so no form: just the cover, title/author, attribution row,
  // optional status line, and a close button.
  root.innerHTML = `
    <div class="friend-book-detail-backdrop" data-friend-book-backdrop></div>
    <div class="friend-book-detail-card" role="dialog" aria-modal="true" aria-labelledby="${TITLE_ID}">
      <button type="button" class="modal-close-btn friend-book-detail-close" id="${CLOSE_ID}" aria-label="Close">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
        </svg>
      </button>
      <div class="friend-book-detail-cover" id="${COVER_ID}"></div>
      <div class="friend-book-detail-meta">
        <h2 class="friend-book-detail-title" id="${TITLE_ID}" tabindex="-1"></h2>
        <p class="friend-book-detail-author" id="${AUTHOR_ID}"></p>
        <div class="friend-book-detail-attribution" id="${ATTRIBUTION_ID}"></div>
        <div class="friend-book-detail-status" id="${STATUS_ID}"></div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  document.getElementById(CLOSE_ID).addEventListener('click', () => closeFriendBookDetail());
  root.querySelector('[data-friend-book-backdrop]').addEventListener(
    'click',
    () => closeFriendBookDetail(),
  );
}

function setCover(book) {
  const host = document.getElementById(COVER_ID);
  if (!host) return;
  const title = book.title || 'Untitled';
  const author = book.author || '';
  if (book.coverImage) {
    const dataUrl = `data:${book.mimeType || 'image/jpeg'};base64,${book.coverImage}`;
    host.innerHTML = `<img src="${dataUrl}" alt="${escapeHtml(title)} cover" data-fit="${book.coverFit || 'contain'}">`;
  } else {
    // Same fallback pattern as the Library card.
    host.innerHTML = `
      <div class="generated-cover" style="background:${generatedCoverColor(title)}">
        <span class="generated-title">${escapeHtml(title)}</span>
        ${author ? `<span class="generated-author">${escapeHtml(author)}</span>` : ''}
      </div>
    `;
  }
}

function setMeta(book, connection) {
  const titleEl = document.getElementById(TITLE_ID);
  const authorEl = document.getElementById(AUTHOR_ID);
  const attrEl = document.getElementById(ATTRIBUTION_ID);
  const statusEl = document.getElementById(STATUS_ID);

  if (titleEl) titleEl.textContent = book.title || 'Untitled';
  if (authorEl) {
    if (book.author) {
      authorEl.textContent = book.author;
      authorEl.style.display = '';
    } else {
      authorEl.textContent = '';
      authorEl.style.display = 'none';
    }
  }

  if (attrEl) {
    attrEl.replaceChildren();
    const name = displayNameForConnection(connection);
    const avatar = renderFriendAvatar(connection, { size: 'sm', ariaLabel: name });
    attrEl.appendChild(avatar);
    const text = document.createElement('span');
    text.className = 'friend-book-detail-attribution-text';
    text.textContent = `From ${name}'s shelf`;
    attrEl.appendChild(text);
  }

  if (statusEl) {
    statusEl.replaceChildren();
    const rs = normalizeReadingStatus(book);
    if (rs === READING_STATUS.READING) {
      statusEl.innerHTML = `<span class="friend-book-detail-reading"><span class="reading-glyph" aria-hidden="true">◐</span> Currently reading</span>`;
    } else if (rs === READING_STATUS.READ) {
      const dateText = formatMonthYearDisplay(book.dateRead);
      if (dateText) {
        statusEl.innerHTML = `<span class="friend-book-detail-finished">Finished ${escapeHtml(dateText)}</span>`;
      } else {
        statusEl.innerHTML = `<span class="friend-book-detail-finished">Finished</span>`;
      }
    }
    // Want-to-read or unknown: status line stays empty.
  }
}

function trapFocusKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFriendBookDetail();
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
 * Open the friend's book-detail modal.
 *
 * @param {{ book: object, connection: object, returnFocusTo?: HTMLElement|null }} opts
 */
export function openFriendBookDetail({ book, connection, returnFocusTo } = {}) {
  if (!book || !connection) return;
  ensureMarkup();
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;

  _focusReturnEl = returnFocusTo || document.activeElement || null;

  setCover(book);
  setMeta(book, connection);

  overlay.style.display = 'block';
  document.body.classList.add('modal-open');
  _isOpen = true;
  pushOverlayState('friend-book-detail');

  _keydownHandler = trapFocusKeydown;
  document.addEventListener('keydown', _keydownHandler);

  requestAnimationFrame(() => {
    const close = document.getElementById(CLOSE_ID);
    if (close) close.focus({ preventScroll: true });
  });
}

/**
 * Close the friend's book-detail modal. Safe to call when not open.
 *
 * Note on body.modal-open: when the drawer was open behind us it ALSO holds
 * `modal-open`. We only remove the class if no other dialog is still
 * present + visible — checked by sniffing for `.friends-drawer` /
 * `.friend-shelf-overlay` / the modal id with `display:block`. This keeps
 * the body lock consistent with other surfaces stacked on top of us.
 *
 * @param {boolean} [fromPopstate]
 */
export function closeFriendBookDetail(fromPopstate = false) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) { _isOpen = false; return; }
  overlay.style.display = 'none';

  // Only release the body modal-lock if no other modal/dialog is still up.
  // Drawer still open behind us → keep modal-open so its scroll-lock holds.
  const drawerOverlay = document.getElementById('friendsOverlay');
  const otherOverlayUp = drawerOverlay && drawerOverlay.style.display === 'block';
  if (!otherOverlayUp) {
    document.body.classList.remove('modal-open');
  }

  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = null;
  }
  if (_isOpen && !fromPopstate) popOverlayState();
  _isOpen = false;

  if (_focusReturnEl && typeof _focusReturnEl.focus === 'function') {
    try { _focusReturnEl.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  _focusReturnEl = null;
}

export function isFriendBookDetailOpen() { return _isOpen; }
