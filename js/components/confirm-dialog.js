// confirm-dialog.js — Lightweight modal confirmation dialog.
//
// Shipped with issue #131 (Mute / Remove friend) for the "Remove friend"
// confirmation. Generic enough that future destructive actions (e.g. delete-
// account, clear-library) can reuse it; kept tiny so the surface area stays
// auditable.
//
// API:
//
//   const confirmed = await openConfirmDialog({
//     title: 'Remove Maya as a friend?',
//     body:  'You won't see each other's shelves or activity.',
//     confirmLabel: 'Remove',
//     destructive: true,
//   });
//   if (confirmed) { ... }
//
// Returns a Promise<boolean> that resolves to true on confirm, false on
// cancel / backdrop click / ESC. Idempotent open: a second openConfirmDialog
// call closes the previous one (resolving its promise to false) before
// opening the new one.

const OVERLAY_ID = 'bookishConfirmDialog';
const TITLE_ID = 'bookishConfirmDialogTitle';
const BODY_ID = 'bookishConfirmDialogBody';
const CONFIRM_ID = 'bookishConfirmDialogConfirm';
const CANCEL_ID = 'bookishConfirmDialogCancel';
const BACKDROP_ID = 'bookishConfirmDialogBackdrop';

let _activeReject = null; // resolves the active dialog's promise to false on tear-down
let _keydownHandler = null;
let _focusReturnEl = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function teardown(resultIfStillPending = false) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = null;
  }
  if (_activeReject) {
    const r = _activeReject;
    _activeReject = null;
    r(resultIfStillPending);
  }
  if (_focusReturnEl && typeof _focusReturnEl.focus === 'function') {
    try { _focusReturnEl.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  _focusReturnEl = null;
}

/**
 * Open the confirmation dialog. Returns a promise resolving to true on
 * confirm, false on cancel / dismiss.
 *
 * @param {{
 *   title: string,
 *   body?: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   destructive?: boolean,
 * }} args
 * @returns {Promise<boolean>}
 */
export function openConfirmDialog(args) {
  // If a dialog is already open, dismiss it (resolving its promise to false)
  // before opening the new one. This shouldn't happen in the spec'd flows
  // but keeps the module robust against double-open races.
  teardown(false);

  const {
    title = 'Are you sure?',
    body = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
  } = args || {};

  _focusReturnEl = (typeof document !== 'undefined') ? document.activeElement : null;

  return new Promise((resolve) => {
    _activeReject = resolve; // any tear-down without explicit confirm = false

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'confirm-dialog-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog-backdrop" id="${BACKDROP_ID}"></div>
      <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="${TITLE_ID}" aria-describedby="${BODY_ID}">
        <h3 class="confirm-dialog-title" id="${TITLE_ID}">${escapeHtml(title)}</h3>
        <p class="confirm-dialog-body" id="${BODY_ID}">${escapeHtml(body)}</p>
        <div class="confirm-dialog-actions">
          <button type="button" class="btn confirm-dialog-cancel" id="${CANCEL_ID}">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn ${destructive ? 'destructive' : 'primary'} confirm-dialog-confirm" id="${CONFIRM_ID}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (val) => {
      // Pull resolve out before teardown clears it, so we can resolve(true)
      // for confirm without teardown also resolving false.
      const r = _activeReject;
      _activeReject = null;
      teardown(false);
      if (r) r(val);
    };

    document.getElementById(CONFIRM_ID).addEventListener('click', () => close(true));
    document.getElementById(CANCEL_ID).addEventListener('click', () => close(false));
    document.getElementById(BACKDROP_ID).addEventListener('click', () => close(false));

    _keydownHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter' && document.activeElement === document.getElementById(CONFIRM_ID)) {
        // Already on the confirm button — let Enter fire its click.
        // Default browser behavior handles this; no explicit close call.
      }
    };
    document.addEventListener('keydown', _keydownHandler);

    // Focus the cancel button by default (safer for destructive actions).
    requestAnimationFrame(() => {
      const cancel = document.getElementById(CANCEL_ID);
      if (cancel) cancel.focus({ preventScroll: true });
    });
  });
}

/**
 * Programmatically close any open confirm dialog (resolves to false).
 */
export function closeConfirmDialog() {
  teardown(false);
}

/**
 * Whether a confirm dialog is currently open. Test hook + caller-side guard.
 */
export function isConfirmDialogOpen() {
  return !!document.getElementById(OVERLAY_ID);
}
