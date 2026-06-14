// prompt_dialog.js — Lightweight modal text-input dialog.
//
// Sibling of confirm_dialog.js — same look and lifecycle, but with a single
// text field. Shipped for "Rename friend" (#131 follow-up); generic enough for
// any short single-value prompt.
//
// API:
//   const value = await openPromptDialog({
//     title: 'Rename friend',
//     initialValue: 'Maya',
//     placeholder: 'Their name',
//     confirmLabel: 'Save',
//     maxLength: 64,
//   });
//   if (value != null) { ... }   // null === cancelled / dismissed / unchanged-empty
//
// Resolves to the TRIMMED string on confirm, or null on cancel / backdrop /
// ESC. Confirm is disabled while the field is empty. Idempotent open: a second
// call dismisses the previous one (resolving it to null) first.

const OVERLAY_ID = 'bookishPromptDialog';
const TITLE_ID = 'bookishPromptDialogTitle';
const INPUT_ID = 'bookishPromptDialogInput';
const CONFIRM_ID = 'bookishPromptDialogConfirm';
const CANCEL_ID = 'bookishPromptDialogCancel';
const BACKDROP_ID = 'bookishPromptDialogBackdrop';

let _activeResolve = null;
let _keydownHandler = null;
let _focusReturnEl = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function teardown(resultIfStillPending = null) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = null;
  }
  if (_activeResolve) {
    const r = _activeResolve;
    _activeResolve = null;
    r(resultIfStillPending);
  }
  if (_focusReturnEl && typeof _focusReturnEl.focus === 'function') {
    try { _focusReturnEl.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  _focusReturnEl = null;
}

/**
 * Open the prompt dialog. Resolves to the trimmed input on confirm, null on
 * cancel/dismiss.
 *
 * @param {{
 *   title: string,
 *   body?: string,
 *   initialValue?: string,
 *   placeholder?: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   maxLength?: number,
 * }} args
 * @returns {Promise<string|null>}
 */
export function openPromptDialog(args) {
  teardown(null);

  const {
    title = 'Enter a value',
    body = '',
    initialValue = '',
    placeholder = '',
    confirmLabel = 'Save',
    cancelLabel = 'Cancel',
    maxLength = 64,
  } = args || {};

  _focusReturnEl = (typeof document !== 'undefined') ? document.activeElement : null;

  return new Promise((resolve) => {
    _activeResolve = resolve;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    // Reuse the confirm-dialog visual classes for a consistent look.
    overlay.className = 'confirm-dialog-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog-backdrop" id="${BACKDROP_ID}"></div>
      <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="${TITLE_ID}">
        <h3 class="confirm-dialog-title" id="${TITLE_ID}">${escapeHtml(title)}</h3>
        ${body ? `<p class="confirm-dialog-body">${escapeHtml(body)}</p>` : ''}
        <input id="${INPUT_ID}" class="prompt-dialog-input" type="text"
               value="${escapeHtml(initialValue)}" placeholder="${escapeHtml(placeholder)}"
               maxlength="${Number(maxLength) || 64}" autocomplete="off" autocapitalize="words" />
        <div class="confirm-dialog-actions">
          <button type="button" class="btn confirm-dialog-cancel" id="${CANCEL_ID}">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn primary confirm-dialog-confirm" id="${CONFIRM_ID}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = document.getElementById(INPUT_ID);
    const confirmBtn = document.getElementById(CONFIRM_ID);

    const close = (val) => {
      const r = _activeResolve;
      _activeResolve = null;
      teardown(null);
      if (r) r(val);
    };

    const syncDisabled = () => { confirmBtn.disabled = input.value.trim().length === 0; };
    const submit = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      close(v);
    };

    input.addEventListener('input', syncDisabled);
    syncDisabled();
    confirmBtn.addEventListener('click', submit);
    document.getElementById(CANCEL_ID).addEventListener('click', () => close(null));
    document.getElementById(BACKDROP_ID).addEventListener('click', () => close(null));

    _keydownHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', _keydownHandler);

    requestAnimationFrame(() => {
      if (input) {
        input.focus({ preventScroll: true });
        // Place caret at the end (rename starts from the current name).
        try { const n = input.value.length; input.setSelectionRange(n, n); } catch { /* ignore */ }
      }
    });
  });
}

/** Programmatically close any open prompt dialog (resolves to null). */
export function closePromptDialog() { teardown(null); }

/** Whether a prompt dialog is currently open. Test hook. */
export function isPromptDialogOpen() { return !!document.getElementById(OVERLAY_ID); }
