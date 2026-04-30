// invite-modal.js — Sender-side invite modal.
//
// Displays a generated invite as a QR code + copy-link button. Hooks
// directly into the dedicated #inviteModal overlay in index.html. Dynamic;
// no markup is shipped pre-baked — the modal body is rendered on open and
// torn down on close.
//
// Friends Issue 2 (Surface 6) — entry point lives in Account → Add a friend
// for now; the drawer's "+ Add" affordance will replace this entry in
// Issue 3.

import * as friends from '../core/friends.js';
import * as tarnService from '../core/tarn_service.js';
import { makeQR, qrToSvg } from '../lib/qrcode/qrcode.js';
import { pushOverlayState, popOverlayState } from '../core/overlay_history.js';

const MODAL_ID = 'inviteModal';
const CONTENT_ID = 'inviteModalContent';

let _isOpen = false;

function ensureMarkup() {
  if (document.getElementById(MODAL_ID)) return;
  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.className = 'modal-overlay';
  root.style.display = 'none';
  root.innerHTML = `
    <div class="modal-backdrop" data-invite-backdrop></div>
    <div class="invite-modal" role="dialog" aria-modal="true" aria-labelledby="inviteModalTitle">
      <button class="modal-close-btn" data-invite-close aria-label="Close">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
        </svg>
      </button>
      <div id="${CONTENT_ID}"></div>
    </div>
  `;
  document.body.appendChild(root);

  // Close affordances
  root.querySelector('[data-invite-close]').addEventListener('click', closeInviteModal);
  root.querySelector('[data-invite-backdrop]').addEventListener('click', closeInviteModal);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function renderLoading(content) {
  content.innerHTML = `
    <div class="invite-pane invite-pane-loading">
      <h2 id="inviteModalTitle">Invite a friend</h2>
      <p class="invite-pane-helper">Generating your invite link…</p>
      <div class="invite-spinner" aria-hidden="true"></div>
    </div>
  `;
}

function renderError(content, message, retry) {
  content.innerHTML = `
    <div class="invite-pane invite-pane-error">
      <h2 id="inviteModalTitle">Invite a friend</h2>
      <p class="invite-pane-helper">We couldn't generate an invite right now.</p>
      <pre class="invite-pane-error-msg">${escapeHtml(message || 'Unknown error')}</pre>
      <div class="invite-actions">
        <button type="button" class="btn primary" data-invite-retry>Try again</button>
      </div>
    </div>
  `;
  if (retry) {
    content.querySelector('[data-invite-retry]').addEventListener('click', retry);
  }
}

function renderInvite(content, invite) {
  const qrSvg = (() => {
    try {
      const matrix = makeQR(invite.invite_url);
      return qrToSvg(matrix, { scale: 6, margin: 4 });
    } catch (err) {
      console.warn('[Bookish:InviteModal] QR render failed:', err.message);
      return `<div class="invite-qr-fallback">QR couldn't render — use the copy-link button below.</div>`;
    }
  })();

  const expiresDate = invite.expires_at
    ? new Date(invite.expires_at * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })
    : '';

  content.innerHTML = `
    <div class="invite-pane">
      <h2 id="inviteModalTitle">Invite a friend</h2>
      <p class="invite-pane-helper">
        They'll see your shelf and you'll see theirs. Either of you can mute or remove
        the connection anytime.
      </p>

      <div class="invite-qr-wrap">${qrSvg}</div>

      <div class="invite-actions">
        <button type="button" class="btn primary" data-invite-copy>Copy invite link</button>
      </div>

      <p class="invite-meta">
        Single-use link. ${expiresDate ? `Expires ${escapeHtml(expiresDate)}.` : 'Expires in 7 days.'}
      </p>

      <details class="invite-link-details">
        <summary>Show link</summary>
        <code class="invite-link-text">${escapeHtml(invite.invite_url)}</code>
      </details>
    </div>
  `;

  const copyBtn = content.querySelector('[data-invite-copy]');
  copyBtn.addEventListener('click', async () => {
    const url = invite.invite_url;
    let copied = false;
    try {
      if (navigator.share) {
        // System share sheet is the better mobile UX.
        try {
          await navigator.share({
            title: 'Bookish invite',
            text: 'Join me on Bookish',
            url,
          });
          copied = true;
        } catch (shareErr) {
          // User dismissed share sheet — silently fall through to clipboard.
          if (shareErr?.name !== 'AbortError') {
            console.warn('[Bookish:InviteModal] navigator.share failed:', shareErr.message);
          }
        }
      }
      if (!copied) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch (err) {
      console.warn('[Bookish:InviteModal] copy failed:', err.message);
    }
    if (copied) {
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      copyBtn.disabled = true;
      setTimeout(() => {
        copyBtn.textContent = original;
        copyBtn.disabled = false;
      }, 1500);
    } else {
      copyBtn.textContent = "Couldn't copy — try the link below";
      setTimeout(() => { copyBtn.textContent = 'Copy invite link'; }, 2500);
    }
  });
}

/**
 * Open the invite modal and kick off invite generation.
 *
 * @param {{ displayName?: string }} [opts]
 */
export async function openInviteModal(opts = {}) {
  if (_isOpen) return;
  ensureMarkup();
  if (!tarnService.isLoggedIn()) {
    console.warn('[Bookish:InviteModal] not logged in — cannot generate invite');
    return;
  }

  const modal = document.getElementById(MODAL_ID);
  const content = document.getElementById(CONTENT_ID);
  if (!modal || !content) return;

  modal.style.display = 'flex';
  document.body.classList.add('modal-open');
  _isOpen = true;
  pushOverlayState('invite');

  renderLoading(content);

  const displayName = (opts.displayName || tarnService.displayName() || tarnService.getEmail()?.split('@')[0] || '').trim();

  const generate = async () => {
    renderLoading(content);
    try {
      const invite = await friends.generateInvite({ displayName, expiryDays: 7 });
      if (!_isOpen) return; // user closed before generation finished
      renderInvite(content, invite);
    } catch (err) {
      console.error('[Bookish:InviteModal] generate failed:', err);
      if (_isOpen) renderError(content, err.message, generate);
    }
  };

  generate();
}

/**
 * Close the modal and tear down its body. Safe to call when not open.
 *
 * @param {boolean} [fromPopstate]
 */
export function closeInviteModal(fromPopstate = false) {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) { _isOpen = false; return; }
  modal.style.display = 'none';
  const content = document.getElementById(CONTENT_ID);
  if (content) content.innerHTML = '';
  document.body.classList.remove('modal-open');
  if (_isOpen && !fromPopstate) popOverlayState();
  _isOpen = false;
}

/**
 * Test hook — current open state (used by browser tests).
 */
export function isInviteModalOpen() { return _isOpen; }
