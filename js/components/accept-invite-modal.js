// accept-invite-modal.js — Recipient-side invite preview + accept modal.
//
// Renders dynamically into a dedicated overlay. The flow:
//   1. previewInviteToken (non-consuming) — show inviter's display name +
//      fingerprint and ask the user to confirm a label.
//   2. On Accept: redeemInviteToken — atomic single-use redemption. The
//      recipient's chosen label is stashed against the inviter's share_pub
//      so it'll be applied the moment the connection materializes (the
//      connection only appears after the inviter's session auto-accepts and
//      the recipient polls listIncomingRequests).
//   3. On Decline: dismiss the modal. Token is NOT consumed; the user can
//      reopen the link before expiry.
//
// Friends Issue 2 (Surface 6).

import * as friends from '../core/friends.js';
import * as tarnService from '../core/tarn_service.js';
import { pushOverlayState, popOverlayState } from '../core/overlay_history.js';

const MODAL_ID = 'acceptInviteModal';
const CONTENT_ID = 'acceptInviteModalContent';

let _isOpen = false;
let _currentInvite = null;

function ensureMarkup() {
  if (document.getElementById(MODAL_ID)) return;
  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.className = 'modal-overlay';
  root.style.display = 'none';
  root.innerHTML = `
    <div class="modal-backdrop" data-accept-backdrop></div>
    <div class="accept-invite-modal" role="dialog" aria-modal="true" aria-labelledby="acceptInviteTitle">
      <button class="modal-close-btn" data-accept-close aria-label="Close">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
        </svg>
      </button>
      <div id="${CONTENT_ID}"></div>
    </div>
  `;
  document.body.appendChild(root);

  root.querySelector('[data-accept-close]').addEventListener('click', () => closeAcceptInviteModal('decline'));
  root.querySelector('[data-accept-backdrop]').addEventListener('click', () => closeAcceptInviteModal('decline'));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function renderLoading(content) {
  content.innerHTML = `
    <div class="invite-pane invite-pane-loading">
      <h2 id="acceptInviteTitle">Loading invite…</h2>
      <div class="invite-spinner" aria-hidden="true"></div>
    </div>
  `;
}

function renderUnavailable(content, reason) {
  const messages = {
    expired: { title: 'This invite has expired', body: 'Ask your friend for a new one.' },
    used:    { title: 'This invite has already been used', body: 'Ask your friend for a new one.' },
    notfound:{ title: "We couldn't find this invite", body: "The link may be wrong, or it may have been revoked." },
    generic: { title: "We couldn't open this invite", body: 'Try the link again, or ask your friend to send a fresh one.' },
  };
  const m = messages[reason] || messages.generic;
  content.innerHTML = `
    <div class="invite-pane invite-pane-error">
      <h2 id="acceptInviteTitle">${escapeHtml(m.title)}</h2>
      <p class="invite-pane-helper">${escapeHtml(m.body)}</p>
      <div class="invite-actions">
        <button type="button" class="btn primary" data-accept-dismiss>Close</button>
      </div>
    </div>
  `;
  content.querySelector('[data-accept-dismiss]').addEventListener('click', () => closeAcceptInviteModal('dismiss'));
}

function renderPreview(content, preview, params) {
  const inviterName = preview.inviter_display_name?.trim() || 'Your friend';
  const fingerprint = preview.inviter_share_pub_fingerprint || '';
  content.innerHTML = `
    <div class="invite-pane">
      <h2 id="acceptInviteTitle">${escapeHtml(inviterName)} wants to be friends</h2>
      <p class="invite-pane-helper">
        You'll see each other's shelves on Bookish. Either of you can mute or remove the
        connection anytime.
      </p>

      <label class="invite-field">
        <span class="invite-field-label">What do you want to call this friend?</span>
        <input type="text" id="acceptInviteLabel" maxlength="64" value="${escapeHtml(inviterName)}" />
        <span class="invite-field-hint">Only you see this name. ${fingerprint ? `Inviter ID: ${escapeHtml(fingerprint)}` : ''}</span>
      </label>

      <div class="invite-actions invite-actions-split">
        <button type="button" class="btn secondary" data-accept-decline>Not now</button>
        <button type="button" class="btn primary" data-accept-confirm>Accept</button>
      </div>

      <p class="invite-meta">
        You can return to this invite later as long as it hasn't expired.
      </p>
    </div>
  `;

  const declineBtn = content.querySelector('[data-accept-decline]');
  const confirmBtn = content.querySelector('[data-accept-confirm]');
  const labelInput = content.querySelector('#acceptInviteLabel');

  declineBtn.addEventListener('click', () => closeAcceptInviteModal('decline'));

  confirmBtn.addEventListener('click', async () => {
    const label = (labelInput.value || '').trim() || inviterName;
    confirmBtn.disabled = true;
    declineBtn.disabled = true;
    confirmBtn.textContent = 'Connecting…';
    try {
      await friends.acceptInvite({
        token_id: params.token_id,
        payload_key: params.payload_key,
        label,
      });
      // Don't await an inbox poll here — the connection materializes
      // asynchronously once the inviter session auto-accepts. We render
      // the success pane immediately so the user isn't held by a slow
      // network round-trip; pendingLabels will be applied by the regular
      // sync loop and any later listConnections call.
      friends.clearPendingInvite();
      renderAccepted(content, label);
      // Fire-and-forget poll for snappier propagation when the inviter
      // happens to be online at the same moment.
      friends.pollForConnectionUpdates().catch(() => {});
    } catch (err) {
      console.error('[Bookish:AcceptInviteModal] redeem failed:', err);
      const code = err?.code;
      if (code === 'INVITE_EXPIRED') renderUnavailable(content, 'expired');
      else if (code === 'INVITE_ALREADY_USED') renderUnavailable(content, 'used');
      else if (code === 'INVITE_NOT_FOUND') renderUnavailable(content, 'notfound');
      else renderUnavailable(content, 'generic');
    }
  });

  // Auto-focus the label input on desktop so the user can rename immediately.
  if (!window.matchMedia?.('(pointer: coarse)').matches) {
    setTimeout(() => labelInput.focus({ preventScroll: true }), 0);
  }
}

function renderAccepted(content, label) {
  content.innerHTML = `
    <div class="invite-pane">
      <h2 id="acceptInviteTitle">You're connected!</h2>
      <p class="invite-pane-helper">
        ${escapeHtml(label)} is now your friend on Bookish. It may take a moment for both
        sides to fully sync. You can manage your connections from <strong>Account</strong>.
      </p>
      <div class="invite-actions">
        <button type="button" class="btn primary" data-accept-dismiss>Done</button>
      </div>
    </div>
  `;
  content.querySelector('[data-accept-dismiss]').addEventListener('click', () => closeAcceptInviteModal('done'));
}

/**
 * Open the accept-invite modal and kick off the preview fetch.
 *
 * @param {{ token_id: string, payload_key: string }} params
 */
export async function openAcceptInviteModal(params) {
  if (!params || !params.token_id || !params.payload_key) return;
  if (_isOpen) return;
  ensureMarkup();

  if (!tarnService.isLoggedIn()) {
    console.warn('[Bookish:AcceptInviteModal] not logged in — should have been routed to signup');
    friends.stashPendingInvite(params);
    return;
  }

  const modal = document.getElementById(MODAL_ID);
  const content = document.getElementById(CONTENT_ID);
  if (!modal || !content) return;

  modal.style.display = 'flex';
  document.body.classList.add('modal-open');
  _isOpen = true;
  _currentInvite = params;
  pushOverlayState('accept-invite');

  renderLoading(content);

  try {
    const preview = await friends.previewInvite(params);
    if (!_isOpen) return;
    if (!preview) {
      renderUnavailable(content, 'notfound');
      return;
    }
    renderPreview(content, preview, params);
  } catch (err) {
    console.error('[Bookish:AcceptInviteModal] preview failed:', err);
    if (_isOpen) renderUnavailable(content, 'generic');
  }
}

export function closeAcceptInviteModal(reason = 'dismiss', fromPopstate = false) {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) { _isOpen = false; _currentInvite = null; return; }
  modal.style.display = 'none';
  const content = document.getElementById(CONTENT_ID);
  if (content) content.innerHTML = '';
  document.body.classList.remove('modal-open');
  // On decline / dismiss, the pending invite stash should be cleared so a
  // future page load doesn't auto-reopen the modal. (User can re-open the
  // link from history if they change their mind — token is not consumed.)
  // 'done' (accept) also clears via friends.clearPendingInvite() in the
  // confirm path. Be idempotent.
  if (reason !== 'done') friends.clearPendingInvite();
  if (_isOpen && !fromPopstate) popOverlayState();
  _isOpen = false;
  _currentInvite = null;
}

export function isAcceptInviteModalOpen() { return _isOpen; }
export function _currentParamsForTest() { return _currentInvite; }
