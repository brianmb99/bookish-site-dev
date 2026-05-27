// account_key_flows.js - Account-key reveal, copy, view, and replace UI flows.

const SVG_SHIELD = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`;

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

/**
 * Build the inner markup for the 24-word account-key grid. Used by signup
 * reveal and Settings -> Account & Security -> View / Replace flows.
 *
 * @param {string} accountKey 24-word string
 * @returns {string} HTML string
 */
export function buildAccountKeyGridMarkup(accountKey) {
  const words = accountKey.trim().split(/\s+/);
  const wordCells = words.map((w, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `<li class="account-key-word"><span class="account-key-word-num">${n}</span><span class="account-key-word-text">${escapeHtml(w)}</span></li>`;
  }).join('');
  return `
    <ol class="account-key-grid">${wordCells}</ol>
    <div class="account-key-actions-row">
      <button data-account-key-copy type="button" class="btn secondary">Copy words</button>
    </div>
  `;
}

/**
 * Wire the copy button (`[data-account-key-copy]`) inside `root` to copy
 * `accountKey` to the clipboard, with transient feedback on the button.
 */
export function wireAccountKeyCopyButton(root, accountKey, deps = {}) {
  const {
    clipboard = globalThis.navigator?.clipboard,
    setTimeoutImpl = globalThis.setTimeout,
  } = deps;
  const copyBtn = root.querySelector('[data-account-key-copy]');
  if (!copyBtn) return;
  copyBtn.addEventListener('click', async () => {
    try {
      await clipboard.writeText(accountKey);
      copyBtn.textContent = 'Copied';
      setTimeoutImpl(() => { copyBtn.textContent = 'Copy words'; }, 1500);
    } catch {
      copyBtn.textContent = "Couldn't copy";
      setTimeoutImpl(() => { copyBtn.textContent = 'Copy words'; }, 1500);
    }
  });
}

/**
 * Render the post-register account-key reveal. Shows the 24 words in a
 * numbered grid plus a copy button. The Continue button is enabled by
 * default; only Continue triggers the post-signup handoff.
 *
 * Close-via-X / backdrop / swipe-dismiss close the modal via the normal
 * modal-close path but DO NOT fire `onContinue()`. Tapping X means
 * "close this dialog, I'm not done with it" - not "I've saved the key,
 * take me into the app." If the user dismisses without tapping
 * Continue, they're still logged in (the account exists) and can
 * re-open Settings -> Account & Security to view the key any time.
 *
 * No save-proof gate: the user can view this key again any time from
 * Settings (recovery v2, Model B by default). Type-back or checkbox
 * gating at signup is security theater that retrieval-from-Settings
 * solves more cleanly.
 *
 * @param {HTMLElement} content
 * @param {{
 *   accountKey: string,
 *   onContinue: () => void,
 * }} opts
 */
export function renderAccountKeyView(content, opts) {
  const { accountKey, onContinue } = opts;

  content.innerHTML = `
    <div class="auth-form account-key-view">
      <div class="auth-header">
        <div class="auth-icon">${SVG_SHIELD}</div>
        <h2>Your account key</h2>
        <p>Save these 24 words somewhere safe \u2014 a password manager works well. We can't reset your account for you, but you can view this key again any time in Settings \u2192 Account &amp; Security.</p>
      </div>

      ${buildAccountKeyGridMarkup(accountKey)}

      <button id="accountKeyContinueBtn" class="btn primary auth-submit">
        Continue to Bookish
      </button>
    </div>
  `;

  const continueBtn = content.querySelector('#accountKeyContinueBtn');
  wireAccountKeyCopyButton(content, accountKey);

  let fired = false;
  continueBtn.addEventListener('click', () => {
    if (fired) return;
    fired = true;
    onContinue();
  });
}

/**
 * Start the View account key flow: password prompt (with inline-error
 * retry) -> SDK call -> grid overlay. The password dialog stays open on
 * wrong-password attempts; cancel aborts the flow.
 *
 * @param {{ onCompleted?: () => void }} [opts]
 * @param {{
 *   tarnService: object,
 *   requestPasswordConfirmation: Function,
 *   showResultOverlay?: Function,
 * }} deps
 */
export async function startViewAccountKeyFlow(opts = {}, deps = {}) {
  const { onCompleted } = opts;
  const {
    tarnService,
    requestPasswordConfirmation,
    showResultOverlay = showAccountKeyResultOverlay,
    onDismissTransientUi = noop,
  } = deps;
  onDismissTransientUi();
  const result = await requestPasswordConfirmation({
    title: 'View your account key',
    body: 'Re-enter your password to see your 24-word account key.',
    confirmLabel: 'Show account key',
    autoFocusInput: 'desktop',
    submit: async (password) => tarnService.accountKey.view({ password }),
  });
  if (!result || !result.accountKey) return;
  onDismissTransientUi();
  showResultOverlay({
    heading: 'Your account key',
    body: 'Save these 24 words somewhere safe \u2014 a password manager works well. You can view this key again any time in Settings \u2192 Account & Security.',
    accountKey: result.accountKey,
    onDone: typeof onCompleted === 'function' ? onCompleted : undefined,
  }, deps);
}

/**
 * Start the Replace account key flow: confirmation -> password (with
 * inline-error retry) -> rotate -> new grid. The confirmation copy spells
 * out that the saved 24 words stop working.
 */
export async function startReplaceAccountKeyFlow(deps = {}) {
  const {
    tarnService,
    confirmDialog,
    requestPasswordConfirmation,
    showResultOverlay = showAccountKeyResultOverlay,
  } = deps;
  const confirmed = await confirmDialog({
    title: 'Replace your account key?',
    body: "Your saved 24 words will stop working. We'll show you a new account key \u2014 save it somewhere safe before continuing.",
    confirmLabel: 'Continue',
  });
  if (!confirmed) return;

  const result = await requestPasswordConfirmation({
    title: 'Confirm your password',
    body: 'Re-enter your password to replace your account key.',
    confirmLabel: 'Replace account key',
    submit: async (password) => tarnService.accountKey.rotate({ password }),
  });
  if (!result || !result.accountKey) return;
  showResultOverlay({
    heading: 'Your new account key',
    body: 'Your old 24 words no longer work. Save these new 24 words somewhere safe before closing this screen.',
    accountKey: result.accountKey,
  }, deps);
}

/**
 * Show the 24-word grid in a full overlay above the account panel. The
 * Done button removes the overlay and returns the user to the panel.
 *
 * The optional `onDone` callback fires ONLY when the user taps Done.
 *
 * @param {{
 *   heading: string,
 *   body: string,
 *   accountKey: string,
 *   onDone?: () => void,
 * }} opts
 */
export function showAccountKeyResultOverlay(opts, deps = {}) {
  const {
    createOverlay = defaultCreateOverlay,
    onDismissTransientUi = noop,
    onWarn = noop,
  } = deps;
  const overlay = createOverlay('account-key-result-overlay');
  overlay.innerHTML = `
    <div class="security-overlay-card">
      <div class="auth-header">
        <div class="auth-icon">${SVG_SHIELD}</div>
        <h2>${escapeHtml(opts.heading)}</h2>
        <p>${escapeHtml(opts.body)}</p>
      </div>
      ${buildAccountKeyGridMarkup(opts.accountKey)}
      <button type="button" data-overlay-done class="btn primary auth-submit">Done</button>
    </div>
  `;
  document.body.appendChild(overlay);
  wireAccountKeyCopyButton(overlay, opts.accountKey, deps);
  const done = overlay.querySelector('[data-overlay-done]');
  if (done) {
    done.addEventListener('click', () => {
      const active = overlay.ownerDocument?.activeElement;
      if (active && overlay.contains(active) && typeof active.blur === 'function') active.blur();
      overlay.remove();
      try { onDismissTransientUi(); } catch (err) {
        onWarn('[AccountUI] transient UI cleanup failed:', err?.message || err);
      }
      if (typeof opts.onDone === 'function') {
        try { opts.onDone(); } catch (err) {
          onWarn('[AccountUI] onDone callback threw:', err?.message || err);
        }
      }
    });
  }
  return overlay;
}
