// account_passkey_settings.js - Logged-in passkey settings UI helpers.

function noop() {}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function defaultCreateOverlay(extraClass = '') {
  const overlay = document.createElement('div');
  overlay.className = 'security-overlay';
  if (extraClass) overlay.classList.add(extraClass);
  return overlay;
}

function defaultHumanizeAccountKeyError(err) {
  const msg = err?.message || '';
  if (err?.name === 'AccountKeyPinningError' || /pinning|pin check|does not match/i.test(msg)) {
    return 'Account-key check failed. Please try again.';
  }
  if (/no_account_key_stored/i.test(msg)) {
    return "No account key is stored on our servers right now. Contact support if you need to restore access.";
  }
  if (/step-up|challenge|wrong password|invalid password|credential/i.test(msg)) {
    return 'Wrong password. Please try again.';
  }
  if (/network|fetch|timeout|offline/i.test(msg)) {
    return "Couldn't reach our servers. Check your connection and try again.";
  }
  return 'Something went wrong. Please try again.';
}

export function createPasskeySupportProbe({ isSupported, onWarn = noop } = {}) {
  let supportedCache = null;
  let supportedProbe = null;

  async function getPasskeysSupported() {
    if (supportedCache !== null) return supportedCache;
    if (!supportedProbe) {
      supportedProbe = (async () => {
        try {
          const ok = await isSupported();
          supportedCache = !!ok;
          return supportedCache;
        } catch (err) {
          onWarn('[AccountUI] passkeys.isSupported probe failed:', err?.message || err);
          supportedCache = false;
          return false;
        }
      })();
    }
    return supportedProbe;
  }

  function resetPasskeysSupportedCache() {
    supportedCache = null;
    supportedProbe = null;
  }

  return {
    getPasskeysSupported,
    resetPasskeysSupportedCache,
  };
}

/**
 * Render the Registered passkeys block. Two paths:
 *   - `isSupported()` resolves false -> render a single muted line.
 *   - `isSupported()` resolves true  -> render subtitle + desc + list
 *     placeholder + Add button, then asynchronously fetch and render the
 *     list.
 *
 * Idempotent: safe to call multiple times against the same panel; later
 * calls re-render the block in place.
 */
export async function hydratePasskeysSection(content, deps = {}) {
  const {
    getPasskeysSupported = async () => false,
  } = deps;
  const block = content.querySelector('#accountPasskeysBlock');
  if (!block) return;

  const supported = await getPasskeysSupported();
  if (!supported) {
    block.innerHTML = `
      <div class="account-security-subtitle">Passkeys</div>
      <div class="account-security-desc account-passkeys-unsupported">Passkeys aren't supported on this browser. Try a recent Chrome, Safari, or Edge.</div>
    `;
    return;
  }

  block.innerHTML = `
    <div class="account-security-subtitle">Registered passkeys</div>
    <div class="account-security-desc">Sign in with Touch ID, Face ID, or Windows Hello instead of typing your password. Each device you register here can sign in independently.</div>
    <ul class="account-passkeys-list" id="accountPasskeysList" aria-live="polite">
      <li class="account-passkeys-loading">Loading passkeys&hellip;</li>
    </ul>
    <div class="account-security-error" id="accountPasskeysError" style="display:none;"></div>
    <div class="account-security-actions">
      <button type="button" id="addPasskeyBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Add passkey</button>
    </div>
  `;

  const addBtn = block.querySelector('#addPasskeyBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => startAddPasskeyFlow(content, deps));
  }

  await refreshPasskeysList(content, deps);
}

/**
 * Fetch the latest passkey list from the SDK and re-render the list rows.
 * Keeps the loading placeholder up while the request is in flight. On
 * error, replaces the list with an empty-state and surfaces the message
 * in the inline error slot so retries are visible.
 */
export async function refreshPasskeysList(content, deps = {}) {
  const {
    passkeys,
    humanizeAccountKeyError = defaultHumanizeAccountKeyError,
    onWarn = noop,
  } = deps;
  const listEl = content.querySelector('#accountPasskeysList');
  const errorEl = content.querySelector('#accountPasskeysError');
  if (!listEl) return;

  const hasRows = !!listEl.querySelector('[data-credential-id]');
  if (!hasRows) {
    listEl.innerHTML = `<li class="account-passkeys-loading">Loading passkeys&hellip;</li>`;
  }

  let entries;
  try {
    entries = await passkeys.list();
  } catch (err) {
    onWarn('[AccountUI] passkeys.list failed:', err?.message || err);
    listEl.innerHTML = '';
    if (errorEl) {
      errorEl.textContent = humanizeAccountKeyError(err, { phraseFlow: false });
      errorEl.style.display = 'block';
    }
    return;
  }
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  if (!Array.isArray(entries) || entries.length === 0) {
    listEl.innerHTML = `<li class="account-passkeys-empty">No passkeys yet. Add one for faster sign-in.</li>`;
    return;
  }

  listEl.innerHTML = entries.map(entry => {
    const labelText = entry.deviceLabel
      ? entry.deviceLabel
      : truncateCredentialId(entry.credentialId);
    const lastUsed = humanizePasskeyDate(entry.lastUsedAt, { neverText: 'Never used' });
    const created = humanizePasskeyDate(entry.createdAt, { neverText: '' });
    const lastUsedText = !lastUsed
      ? ''
      : lastUsed === 'Never used'
        ? 'Never used'
        : `Last used ${lastUsed.charAt(0).toLowerCase() + lastUsed.slice(1)}`;
    const createdText = created ? `Added ${created}` : '';
    const metaLine = [createdText, lastUsedText].filter(Boolean).join(' \u00B7 ');
    return `
      <li class="account-passkeys-row" data-credential-id="${escapeHtml(entry.credentialId)}">
        <div class="account-passkeys-row-main">
          <div class="account-passkeys-row-label">${escapeHtml(labelText)}</div>
          ${metaLine ? `<div class="account-passkeys-row-meta">${escapeHtml(metaLine)}</div>` : ''}
        </div>
        <button type="button" class="account-panel-sub-btn account-panel-sub-btn-secondary account-passkeys-remove" data-action="remove-passkey">Remove</button>
      </li>
    `;
  }).join('');

  listEl.querySelectorAll('[data-action="remove-passkey"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('[data-credential-id]');
      if (!row) return;
      const credentialId = row.getAttribute('data-credential-id');
      const labelEl = row.querySelector('.account-passkeys-row-label');
      const deviceLabel = labelEl ? labelEl.textContent : credentialId;
      startRemovePasskeyFlow(content, { credentialId, deviceLabel }, deps);
    });
  });
}

export function truncateCredentialId(id) {
  if (!id || typeof id !== 'string') return 'Unnamed passkey';
  return id.slice(0, 8) + '\u2026';
}

export function humanizePasskeyDate(ts, opts = {}) {
  const neverText = opts.neverText !== undefined ? opts.neverText : 'Never';
  if (ts == null || ts === 0) return neverText;
  const now = opts.now != null ? opts.now : Date.now();
  const delta = now - ts;
  if (delta < 60 * 1000) return 'Just now';
  if (delta < 60 * 60 * 1000) {
    const m = Math.floor(delta / (60 * 1000));
    return `${m} min ago`;
  }
  if (delta < 24 * 60 * 60 * 1000) {
    const h = Math.floor(delta / (60 * 60 * 1000));
    return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  }
  if (delta < 2 * 24 * 60 * 60 * 1000) return 'Yesterday';
  const d = new Date(ts);
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  const monthDay = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (sameYear && delta < 365 * 24 * 60 * 60 * 1000) return monthDay;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function suggestDeviceLabel(nav = globalThis.navigator) {
  try {
    const uad = nav?.userAgentData;
    const platform = (uad && typeof uad.platform === 'string' ? uad.platform : '') || '';
    if (/^macOS$/i.test(platform)) return 'Mac';
    if (/^Windows$/i.test(platform)) return 'Windows PC';
    if (/^Android$/i.test(platform)) return 'Android';
    const ua = nav?.userAgent || '';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/iPhone|iPod/i.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) return 'Android';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'Windows PC';
    return 'This device';
  } catch {
    return 'This device';
  }
}

/**
 * Start the Add-passkey flow. Opens the dialog with a UA-suggested
 * device-label pre-fill; on submit calls `passkeys.register` (which
 * triggers the WebAuthn prompt). On success, re-renders the list. On
 * failure (user-cancel, hardware unavailable, etc.) closes the dialog
 * and shows an inline error in the section.
 */
export async function startAddPasskeyFlow(content, deps = {}) {
  const {
    passkeys,
    openAddPasskeyDialogImpl = openAddPasskeyDialog,
    onWarn = noop,
  } = deps;
  const errorEl = content.querySelector('#accountPasskeysError');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  const result = await openAddPasskeyDialogImpl({
    suggestion: suggestDeviceLabel(),
  }, deps);
  if (!result || !result.deviceLabel) return;

  try {
    await passkeys.register({ deviceLabel: result.deviceLabel });
  } catch (err) {
    onWarn('[AccountUI] passkeys.register failed:', err?.message || err);
    if (errorEl) {
      errorEl.textContent = humanizePasskeyError(err, deps);
      errorEl.style.display = 'block';
    }
    return;
  }
  await refreshPasskeysList(content, deps);
  showPasskeyAddedAffirmation(content, deps);
}

/**
 * Show a transient success affirmation after a passkey is registered.
 * Appears as a sibling above the list; auto-dismisses after 3s. Idempotent.
 */
export function showPasskeyAddedAffirmation(content, deps = {}) {
  const {
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  } = deps;
  const listEl = content.querySelector('#accountPasskeysList');
  if (!listEl || !listEl.parentNode) return;

  let el = content.querySelector('.account-passkeys-success');
  if (!el) {
    el = document.createElement('div');
    el.className = 'account-passkeys-success';
    el.setAttribute('role', 'status');
    listEl.parentNode.insertBefore(el, listEl);
  }
  el.textContent = '\u2713 Passkey added \u2014 sign in faster next time.';
  el.style.display = 'block';

  if (el._dismissTimer) clearTimeoutImpl(el._dismissTimer);
  el._dismissTimer = setTimeoutImpl(() => {
    el.style.display = 'none';
    el._dismissTimer = null;
  }, 3000);
}

/**
 * Start the Remove-passkey flow. Confirmation dialog -> password prompt
 * -> SDK call -> re-render.
 */
export async function startRemovePasskeyFlow(content, { credentialId, deviceLabel }, deps = {}) {
  const {
    passkeys,
    confirmDialog,
    requestPasswordConfirmation,
  } = deps;
  const errorEl = content.querySelector('#accountPasskeysError');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  const confirmed = await confirmDialog({
    title: 'Remove this passkey?',
    body: `Remove "${deviceLabel}"? You won't be able to sign in with this passkey on this device anymore.`,
    confirmLabel: 'Remove',
  });
  if (!confirmed) return;

  const ok = await requestPasswordConfirmation({
    title: 'Confirm your password',
    body: 'Re-enter your password to remove this passkey.',
    confirmLabel: 'Remove passkey',
    submit: async (password) => {
      await passkeys.remove({ credentialId, password });
      return true;
    },
  });
  if (!ok) return;
  await refreshPasskeysList(content, deps);
}

export function humanizePasskeyError(err, deps = {}) {
  const {
    humanizeAccountKeyError = defaultHumanizeAccountKeyError,
  } = deps;
  const msg = err?.message || '';
  const name = err?.name || '';
  if (name === 'NotAllowedError' || /not allowed|user cancelled|user canceled|cancelled by user/i.test(msg)) {
    return 'The passkey prompt was cancelled. Try again when ready.';
  }
  if (name === 'InvalidStateError' || /already registered|excluded/i.test(msg)) {
    return 'This device already has a passkey registered. Try a different label or remove the existing one first.';
  }
  if (name === 'NotSupportedError' || /not supported|no authenticator|prf/i.test(msg)) {
    return "This device can't register a passkey right now. Make sure your platform authenticator (Touch ID / Windows Hello / security key) is set up.";
  }
  return humanizeAccountKeyError(err, { phraseFlow: false });
}

export function openAddPasskeyDialog({ suggestion }, deps = {}) {
  const {
    createOverlay = defaultCreateOverlay,
    requestAnimationFrameImpl = globalThis.requestAnimationFrame,
  } = deps;
  return new Promise((resolve) => {
    const overlay = createOverlay();
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true">
        <h2 class="security-overlay-title">Add a passkey</h2>
        <p class="security-overlay-body">You'll see a system prompt next \u2014 Touch ID, Face ID, or Windows Hello \u2014 to confirm.</p>
        <div class="form-group">
          <label for="addPasskeyLabel">Name this device</label>
          <input type="text" id="addPasskeyLabel" autocomplete="off" maxlength="64" />
        </div>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>Cancel</button>
          <button type="button" class="btn primary" data-confirm>Add</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const card = overlay.querySelector('.security-overlay-card');
    const input = overlay.querySelector('#addPasskeyLabel');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    input.value = suggestion || '';
    const validate = () => {
      confirmBtn.disabled = input.value.trim().length === 0;
    };
    validate();
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    input.addEventListener('input', validate);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) {
        e.preventDefault();
        confirmBtn.click();
      }
    });
    confirmBtn.addEventListener('click', () => {
      const label = input.value.trim();
      if (!label) return;
      cleanup({ deviceLabel: label });
    });
    cancelBtn.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
    card.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrameImpl(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  });
}
