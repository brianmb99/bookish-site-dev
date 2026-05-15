import { debugLog } from '../core/debug_log.js';

export const STATUS_TOAST_ID = 'bookishStatusToast';
export const MARK_READ_UNDO_MS = 5500;
export const STATUS_TOAST_STYLE = 'position:fixed;top:calc(var(--header-height) + env(safe-area-inset-top) + 8px);left:50%;transform:translateX(-50%);z-index:9001;';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function getDocument(documentRef) {
  return documentRef || globalThis.document;
}

function removeExistingToast(documentRef) {
  getDocument(documentRef)?.getElementById(STATUS_TOAST_ID)?.remove();
}

function createToast({ className, html, role, documentRef }) {
  const doc = getDocument(documentRef);
  removeExistingToast(doc);
  const toast = doc.createElement('div');
  toast.id = STATUS_TOAST_ID;
  toast.className = className;
  if (role) toast.setAttribute('role', role);
  toast.innerHTML = html;
  toast.setAttribute('style', STATUS_TOAST_STYLE);
  doc.body.appendChild(toast);
  return toast;
}

function hideToast(toast) {
  toast.classList.add('hiding');
  setTimeout(() => toast.remove(), 300);
}

export function showStatusToast(message, options = {}) {
  const toast = createToast({
    className: 'toast status-toast',
    html: `<span class="toast-message">${escapeHtml(message)}</span>`,
    documentRef: options.document,
  });
  setTimeout(() => hideToast(toast), options.durationMs ?? 2000);
  return toast;
}

export function showSubscriptionSuccessToast(message, options = {}) {
  const toast = createToast({
    className: 'toast status-toast celebration-toast',
    role: 'status',
    html: `
      <span class="toast-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
      <span class="toast-message">${escapeHtml(message)}</span>
    `,
    documentRef: options.document,
  });
  setTimeout(() => hideToast(toast), options.durationMs ?? 4500);
  return toast;
}

export function showMarkAsReadUndoToast(options = {}) {
  const toast = createToast({
    className: 'toast status-toast status-toast-with-action',
    role: 'status',
    html: '<span class="toast-message">Marked as read</span><button type="button" class="toast-undo-btn">Undo</button>',
    documentRef: options.document,
  });

  let cleared = false;
  const remove = () => {
    if (cleared) return;
    cleared = true;
    hideToast(toast);
  };
  const timer = setTimeout(remove, options.durationMs ?? MARK_READ_UNDO_MS);

  toast.querySelector('.toast-undo-btn')?.addEventListener('click', async () => {
    if (cleared || options.canUndo?.() === false) return;
    cleared = true;
    clearTimeout(timer);
    await options.onUndo?.();
    hideToast(toast);
  });

  return toast;
}

export function setStatusLine(statusEl, message) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.remove('warning');
  debugLog('[Bookish] status:', message);
}
