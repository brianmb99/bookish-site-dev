// account_ui.js — Account management UI (signup, login, account panel)
// Uses tarn_service for all auth operations.

import uiStatusManager from './ui_status_manager.js';
import { stopSync, startSync, markInitialSyncDone } from './sync_manager.js';
import * as tarnService from './core/tarn_service.js';
import * as subscription from './core/subscription.js';
import { pushOverlayState, popOverlayState } from './core/overlay_history.js';
import { attachSwipeDismiss } from './core/swipe_dismiss.js';
import { msToDateInputUtc } from './core/id_core.js';
import * as friends from './core/friends.js';
import * as friendsRouter from './core/friends_router.js';
import * as accountKeyReminder from './core/account_key_reminder.js';
import { debugLog } from './core/debug_log.js';
import {
  isFriendsHiddenFromHeader,
  setHideFriendsFromHeader,
  FRIENDS_VISIBILITY_EVENT,
} from './components/friend-glyph-trigger.js';
import {
  humanizePasskeySigninError,
  promptStalePasskeyRepair,
  renderCreateAccountForm as renderCreateAccountAuthForm,
  renderSignInForm as renderSignInAuthForm,
} from './components/account_auth_flows.js';
import {
  renderAccountKeyView as renderAccountKeyReveal,
  startReplaceAccountKeyFlow as startReplaceAccountKeyFlowModule,
  startViewAccountKeyFlow as startViewAccountKeyFlowModule,
} from './components/account_key_flows.js';
import {
  createPasskeySupportProbe,
  humanizePasskeyDate,
  hydratePasskeysSection as hydratePasskeySettingsSection,
  showPasskeyAddedAffirmation,
  suggestDeviceLabel,
  truncateCredentialId,
} from './components/account_passkey_settings.js';

// Track the swipe-dismiss cleanup so we can detach on close.
let _accountResetSwipe = null;

// SVG icons for auth forms
const SVG_EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const SVG_EDIT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const SVG_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

const passkeySupportProbe = createPasskeySupportProbe({
  isSupported: () => tarnService.passkeys.isSupported(),
  onWarn: (...args) => console.warn(...args),
});

/**
 * Full logout: stop sync, clear Tarn session, clear IndexedDB cache,
 * clear in-memory book entries, refresh UI.
 */
async function performLogout() {
  stopSync();
  await tarnService.logout();
  subscription.resetStatus();

  // Clear the account-key reminder counter + flags so a different user
  // signing in on the same browser is evaluated freshly. The reminder's
  // localStorage state is per-device; the previous user's "saved" flag
  // shouldn't suppress the new user's reminder. (Phase 5)
  try { accountKeyReminder.reset(); } catch {}

  // Clear IndexedDB cache so next user doesn't see stale books
  try {
    if (window.bookishCache?.clearAll) await window.bookishCache.clearAll();
  } catch {}

  // Clear in-memory book entries so the UI redraws immediately
  if (window.bookishApp?.clearBooks) window.bookishApp.clearBooks();

  uiStatusManager.refresh();
}

const BOOKISH_API = window.BOOKISH_API_URL || 'https://bookish-api.bookish.workers.dev';

// Transient state for UI status manager
const transientState = {
  justSignedIn: false,
  signInTime: 0,
  justCreated: false,
  createdTime: 0,
};

export function getAccountStatus() {
  return {
    isLoggedIn: tarnService.isLoggedIn(),
    isPersisted: tarnService.isLoggedIn(), // Always true with Tarn
    justSignedIn: transientState.justSignedIn,
    signInTime: transientState.signInTime,
    justCreated: transientState.justCreated,
    createdTime: transientState.createdTime,
  };
}

export async function initAccountUI() {
  debugLog('[Bookish:AccountUI] Initializing...');
  if (tarnService.isLoggedIn()) {
    localStorage.setItem('bookish.hasHadAccount', 'true');
  }
  setupAccountModalListeners();
}

// ============================================================================
// MODAL MANAGEMENT
// ============================================================================

export async function openAccountModal(mode) {
  const modal = document.getElementById('accountModal');
  const content = document.getElementById('accountModalContent');
  if (!modal || !content) return;

  modal.dataset.allowClose = 'false';
  await renderAccountModalContent(content, mode);
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  document.body.classList.add('modal-open');

  const modalContent = modal.querySelector('.account-modal');
  if (modalContent) {
    modalContent.style.visibility = 'visible';
    modalContent.style.opacity = '1';
    modalContent.classList.remove('sheet-dismissing');
    // On touch devices: add a drag handle and wire swipe-to-dismiss (#104 followup).
    // Matches the book edit modal pattern for visual consistency.
    if (window.matchMedia('(pointer: coarse)').matches) {
      if (!modalContent.querySelector('.sheet-handle')) {
        const handle = document.createElement('div');
        handle.className = 'sheet-handle';
        modalContent.insertBefore(handle, modalContent.firstChild);
      }
      const handle = modalContent.querySelector('.sheet-handle');
      if (handle && !_accountResetSwipe) {
        _accountResetSwipe = attachSwipeDismiss({
          sheet: modalContent,
          handles: [handle],
          onDismiss: () => closeAccountModal(),
        });
      }
    }
  }

  pushOverlayState('account');

  requestAnimationFrame(() => {
    modal.dataset.allowClose = 'true';
    // Auto-focus the first input on desktop only. On mobile, popping the
    // keyboard immediately covers the form before the user has seen it
    // and creates layout churn with the keyboard-aware sheet handler.
    if (!window.matchMedia('(pointer: coarse)').matches) {
      const firstInput = content.querySelector('input:not([type=hidden])');
      if (firstInput) firstInput.focus({ preventScroll: true });
    }
  });
}

export function closeAccountModal(fromPopstate = false) {
  const modal = document.getElementById('accountModal');
  if (!modal) return;
  // Clean up swipe-dismiss listeners and inline transform from the gesture.
  if (_accountResetSwipe) { _accountResetSwipe(); _accountResetSwipe = null; }
  modal.style.display = 'none';
  const modalContent = modal.querySelector('.account-modal');
  if (modalContent) modalContent.classList.remove('sheet-dismissing');
  document.body.style.overflow = '';
  document.body.classList.remove('modal-open');
  if (!fromPopstate) popOverlayState();
}

function setupAccountModalListeners() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;

  const closeBtn = document.getElementById('accountModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeAccountModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal && modal.dataset.allowClose === 'true') {
      closeAccountModal();
    }
  });

  // Header account button opens modal
  const accountBtn = document.getElementById('accountBtn');
  if (accountBtn) {
    accountBtn.addEventListener('click', () => openAccountModal());
  }
}

// ============================================================================
// CONTENT RENDERING
// ============================================================================

async function renderAccountModalContent(content, mode) {
  if (tarnService.isLoggedIn()) {
    renderAccountPanel(content);
  } else if (mode === 'signin') {
    renderSignInForm(content);
  } else {
    renderCreateAccountForm(content);
  }
}

// ============================================================================
// CREATE ACCOUNT FORM
// ============================================================================

function renderCreateAccountForm(content) {
  renderCreateAccountAuthForm(content, {
    tarnService,
    bookishApiUrl: BOOKISH_API,
    onCreated: ({ email, accountKey }) => completePostCreateAccount(content, { email, accountKey }),
    onSwitchToSignIn: () => renderSignInForm(content),
    onWarn: (...args) => console.warn(...args),
    onError: (...args) => console.error(...args),
  });
}

function completePostCreateAccount(content, { email, accountKey }) {
  tarnService.displayName(email.split('@')[0]);
  localStorage.setItem('bookish.hasHadAccount', 'true');

  transientState.justCreated = true;
  transientState.createdTime = Date.now();
  markInitialSyncDone(); // New account - no books to sync

  subscription.resetStatus();
  subscription.fetchStatus().catch(() => {});

  renderAccountKeyView(content, {
    accountKey,
    onContinue: () => {
      closeAccountModal();
      startSync();
      uiStatusManager.refresh();
      if (typeof window.updateBookDots === 'function') window.updateBookDots();
      friendsRouter.maybeOpenPendingAcceptModal().catch(err =>
        console.warn('[Bookish:AccountUI] friends invite handler failed:', err?.message || err)
      );
    },
  });
}

// ============================================================================
// ACCOUNT KEY VIEW (post-register)
// ============================================================================

function renderAccountKeyView(content, opts) {
  renderAccountKeyReveal(content, opts);
}

// ============================================================================
// SIGN IN FORM
// ============================================================================

function renderSignInForm(content) {
  renderSignInAuthForm(content, {
    tarnService,
    getPasskeysSupported,
    onSignedIn: () => completePostSignIn(),
    onSwitchToCreate: () => renderCreateAccountForm(content),
    onError: (...args) => console.error(...args),
  });
}

/**
 * Run the post-sign-in handoff used by both the password and passkey
 * paths. Sets transient state, kicks off subscription fetch, and (after
 * a 500ms delay matching the original UX) closes the modal, starts sync,
 * refreshes status, updates book dots, and runs the friends-invite
 * redemption check.
 *
 * The 500ms delay lets the "Signed in!" progress text be visible briefly
 * before the modal closes.
 */
function completePostSignIn() {
  transientState.justSignedIn = true;
  transientState.signInTime = Date.now();

  // Fresh subscription state for the signed-in user (#74).
  subscription.resetStatus();
  subscription.fetchStatus().catch(() => {});

  setTimeout(() => {
    closeAccountModal();
    startSync();
    uiStatusManager.refresh();
    if (typeof window.updateBookDots === 'function') window.updateBookDots();
    // Friends invite redemption (#118). If the user signed in to redeem
    // an invite they clicked while logged out, fire the accept modal
    // now that auth is ready.
    friendsRouter.maybeOpenPendingAcceptModal().catch(err =>
      console.warn('[Bookish:AccountUI] friends invite handler failed:', err?.message || err)
    );
    // Phase 5: engagement-milestone reminder. init() is idempotent
    // within a page life — the session counter only increments on the
    // first call. Banner is rendered only when shouldShow() returns
    // true (Model B + ≥2 sessions + ≥5 books + not already saved).
    try { accountKeyReminder.init(); } catch (err) {
      console.warn('[Bookish:AccountUI] accountKeyReminder.init failed:', err?.message || err);
    }
  }, 500);
}

// ============================================================================
// ACCOUNT PANEL (logged-in view)
// ============================================================================

function renderAccountPanel(content) {
  const email = tarnService.getEmail() || '';
  const displayName = tarnService.displayName() || email.split('@')[0] || 'User';
  const initial = (displayName[0] || 'U').toUpperCase();

  // Subscription section (#74). All three states get a block: free users
  // see their count + proactive Subscribe CTA; lapsed users see an
  // expired status + Renew; subscribed users see their renewal date + a
  // Manage subscription link that opens the Stripe Billing Portal.
  const subStatus = subscription.getStatus();
  const count = window.bookishApp?.getActiveEntryCount?.() || 0;
  let subSectionHtml = '';
  if (subStatus === 'free') {
    subSectionHtml = `
      <div class="account-panel-subscription">
        <div class="account-panel-sub-label">Subscription</div>
        <div class="account-panel-sub-value">Trial \u2014 ${count} of ${subscription.FREE_LIMIT} books used</div>
        <div class="account-panel-sub-pitch">Add unlimited books: <strong>$10/year</strong> \u00B7 cancel anytime</div>
        <button type="button" id="accountSubscribeBtn" class="account-panel-sub-btn" data-subscribe-action="subscribe">Subscribe \u2014 $10/year</button>
      </div>
    `;
  } else if (subStatus === 'lapsed') {
    subSectionHtml = `
      <div class="account-panel-subscription">
        <div class="account-panel-sub-label">Subscription</div>
        <div class="account-panel-sub-value">Expired \u2014 renew to keep adding books</div>
        <button type="button" id="accountSubscribeBtn" class="account-panel-sub-btn" data-subscribe-action="renew">Renew \u2014 $10/year</button>
      </div>
    `;
  } else if (subStatus === 'subscribed') {
    const periodEndIso = subscription.getCurrentPeriodEnd();
    let renewLine = 'Subscribed';
    if (periodEndIso) {
      try {
        const d = new Date(periodEndIso);
        renewLine = `Subscribed \u2014 renews ${d.toLocaleDateString('en-US', { dateStyle: 'long' })}`;
      } catch { /* fall back to plain label */ }
    }
    subSectionHtml = `
      <div class="account-panel-subscription">
        <div class="account-panel-sub-label">Subscription</div>
        <div class="account-panel-sub-value">${renewLine}</div>
        <button type="button" id="accountManageBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Manage subscription <span aria-hidden="true" class="external-link-icon">\u2197</span></button>
      </div>
    `;
  }

  content.innerHTML = `
    <div class="auth-form">
      <div class="account-panel-header">
        <div class="account-avatar">${initial}</div>
        <div class="account-panel-info">
          <div class="account-panel-name">
            <span id="displayNameValue">${displayName}</span>
            <button id="editDisplayNameBtn" class="btn-link" title="Edit name">${SVG_EDIT}</button>
          </div>
          <div class="account-panel-email">${email}</div>
        </div>
      </div>

      <div class="account-panel-tagline">Private. Permanent. Yours.</div>

      ${subSectionHtml}

      <div class="account-panel-archive">
        <div class="account-panel-sub-label">Your Permanent Archive</div>
        <a class="account-panel-archive-url" href="#" target="_blank" rel="noopener noreferrer" data-archive-link>arweave.net/U6dP2xK9mN3qRvT8aBc4FdEgH1jKlM2oPqRsTuVwXyZ</a>
        <div class="account-panel-archive-note">Works without Bookish. Private, permanent, and yours regardless of subscription.</div>
        <button type="button" id="accountArchiveBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Open archive <span aria-hidden="true" class="external-link-icon">\u2197</span></button>
      </div>

      <div class="account-panel-security" id="accountPanelSecurity">
        <div class="account-panel-sub-label">Account &amp; Security</div>

        <div class="account-security-block">
          <div class="account-security-subtitle">Account key</div>
          <div class="account-security-desc">A 24-word phrase that's the only way to recover your account if you forget your password.</div>
          <div class="account-security-actions">
            <button type="button" id="viewAccountKeyBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">View account key</button>
          </div>
          <button type="button" id="replaceAccountKeyBtn" class="btn-link account-security-replace-link">Replace account key &rarr;</button>
        </div>

        <div class="account-security-block" id="accountPasskeysBlock">
          <!-- Phase 3: passkey list. Populated by wirePasskeysSection() once
               isSupported() resolves: either the full block (subtitle, desc,
               list placeholder, Add button) when supported, or a single
               muted "not supported" line when not. -->
        </div>

        <div class="account-security-block" id="accountCredentialsBlock">
          <div class="account-security-subtitle">Username &amp; password</div>
          <div class="account-security-desc">Together, these let you sign in. Change either or both at any time.</div>
          <div class="account-security-actions">
            <button type="button" id="changeCredentialsBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Change username or password</button>
          </div>
        </div>
      </div>

      <div class="account-panel-friends" id="accountPanelFriends">
        <div class="account-panel-sub-label">Friends</div>
        <!-- #122: "+ Add a friend" entry moved to the Friends drawer (header glyph).
             Account keeps the read-only Connections + Pending invites lists for
             power-user verification. To invite someone, open the Friends drawer
             from the header and tap "+ Add".
             #124: added the "Show in header" toggle so users who hid the glyph
             from the drawer have a clear path to re-enable it. -->
        <!-- #146: switched from native checkbox to the .toggle-switch
             pattern used by the Owned toggle and the privacy-add toggle.
             Order matters: input must immediately precede .toggle-track
             so the input:checked + .toggle-track adjacent-sibling rule
             applies. Input id stays the same so the wiring still finds it. -->
        <label class="toggle-switch account-friends-toggle" for="accountFriendsShowToggle">
          <span class="account-friends-toggle-label">Show in header</span>
          <input type="checkbox" id="accountFriendsShowToggle" />
          <span class="toggle-track"></span>
        </label>
        <div class="account-friends-section" id="accountConnectionsSection" style="display:none;">
          <div class="account-friends-heading">Connections</div>
          <ul class="account-friends-list" id="accountConnectionsList"></ul>
        </div>
        <div class="account-friends-section" id="accountPendingInvitesSection" style="display:none;">
          <div class="account-friends-heading">Pending invites</div>
          <ul class="account-friends-list" id="accountPendingInvitesList"></ul>
        </div>
        <div class="account-friends-status" id="accountFriendsStatus" style="display:none;"></div>
      </div>

      <div class="account-actions">
        <button id="exportCsvBtn" class="btn secondary account-csv-btn">
          ${SVG_DOWNLOAD} Export CSV
        </button>
        <button id="logoutBtn" class="btn account-signout">
          Sign Out
        </button>
      </div>
    </div>
  `;

  // Subscribe / Renew (#74)
  const subscribeBtn = content.querySelector('#accountSubscribeBtn');
  if (subscribeBtn) {
    subscribeBtn.addEventListener('click', async () => {
      subscribeBtn.disabled = true;
      try {
        await subscription.startCheckout();
        // Success redirects via window.location.assign; below only runs on failure.
      } catch (err) {
        console.error('[AccountUI] Checkout failed:', err?.message || err);
        subscribeBtn.disabled = false;
        subscribeBtn.textContent = "Couldn't start checkout \u2014 try again";
      }
    });
  }

  // Manage subscription (#74 — opens Stripe Billing Portal in new tab)
  const manageBtn = content.querySelector('#accountManageBtn');
  if (manageBtn) {
    manageBtn.addEventListener('click', async () => {
      manageBtn.disabled = true;
      try {
        await subscription.openPortal();
      } catch (err) {
        console.error('[AccountUI] Portal open failed:', err?.message || err);
        manageBtn.textContent = "Couldn't open portal \u2014 try again";
      } finally {
        // Re-enable after a beat so a slow new-tab open doesn't lock the button.
        setTimeout(() => { manageBtn.disabled = false; }, 1500);
      }
    });
  }

  // Open Archive (perma-export page on Arweave — #12). Dummy URL for now,
  // swap to the real TX URL once the page is uploaded. Both the text link
  // and the button navigate to the same place.
  const ARCHIVE_URL = 'https://arweave.net/U6dP2xK9mN3qRvT8aBc4FdEgH1jKlM2oPqRsTuVwXyZ';
  const archiveLink = content.querySelector('[data-archive-link]');
  if (archiveLink) archiveLink.href = ARCHIVE_URL;
  const archiveBtn = content.querySelector('#accountArchiveBtn');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', () => {
      window.open(ARCHIVE_URL, '_blank', 'noopener,noreferrer');
    });
  }

  // Account & Security section — View / Replace + Passkeys (#144 removed the custody toggle).
  wireAccountSecuritySection(content);

  // Friends section (#118 → #122). The "+ Add a friend" entry now lives in
  // the Friends drawer (header glyph). Account keeps the read-only
  // Connections + Pending invites lists for power-user verification.
  // Hydrate async — listConnections / listIssuedInvites hit Tarn.
  refreshFriendsSection(content).catch(err =>
    console.warn('[AccountUI] friends hydrate failed:', err?.message || err)
  );

  // "Show in header" toggle (#124). Reflects the per-device localStorage
  // flag and writes back through setHideFriendsFromHeader, which dispatches
  // FRIENDS_VISIBILITY_EVENT so the header glyph updates live without a
  // reload. This is the canonical re-enable path for users who hid the
  // glyph via the drawer link.
  const showInHeaderToggle = content.querySelector('#accountFriendsShowToggle');
  if (showInHeaderToggle) {
    // checked = visible (i.e. NOT hidden). Default = visible.
    showInHeaderToggle.checked = !isFriendsHiddenFromHeader();
    showInHeaderToggle.addEventListener('change', () => {
      setHideFriendsFromHeader(!showInHeaderToggle.checked);
    });
    // Keep the toggle in sync if the preference changes elsewhere (e.g. the
    // drawer's hide link fires while Account is open in another tab — rare
    // but cheap to handle, and keeps the surfaces consistent).
    const onVisibilityChange = (e) => {
      const hidden = !!(e?.detail?.hidden);
      showInHeaderToggle.checked = !hidden;
    };
    window.addEventListener(FRIENDS_VISIBILITY_EVENT, onVisibilityChange);
    // Detach when the modal closes — the next render() rebuilds the panel
    // and re-binds, so a stale listener would just leak. Hook it via the
    // existing modal close path: a one-shot listener on the modal's hide.
    const accountModal = document.getElementById('accountModal');
    if (accountModal) {
      const cleanup = () => {
        window.removeEventListener(FRIENDS_VISIBILITY_EVENT, onVisibilityChange);
      };
      // MutationObserver on display:none is overkill; just clean up on the
      // close button + backdrop click paths the modal already uses.
      const closeBtn = document.getElementById('accountModalClose');
      if (closeBtn) closeBtn.addEventListener('click', cleanup, { once: true });
      accountModal.addEventListener('click', (e) => {
        if (e.target === accountModal) cleanup();
      }, { once: true });
    }
  }

  // Logout
  content.querySelector('#logoutBtn').addEventListener('click', async () => {
    closeAccountModal();
    await performLogout();
  });

  // Export CSV
  content.querySelector('#exportCsvBtn').addEventListener('click', () => {
    exportBooksToCSV();
  });

  // Edit display name
  content.querySelector('#editDisplayNameBtn').addEventListener('click', () => {
    const valueEl = content.querySelector('#displayNameValue');
    const editBtn = content.querySelector('#editDisplayNameBtn');
    const current = valueEl.textContent;

    valueEl.innerHTML = `<input type="text" id="displayNameInput" value="${current}" />`;
    editBtn.innerHTML = 'Save';
    editBtn.classList.add('save-active');

    const input = content.querySelector('#displayNameInput');
    input.focus();
    input.select();

    const save = () => {
      // Guard against persisting an empty display name. Three-tier fallback:
      // 1. The trimmed input (user's intent)
      // 2. The current value if non-empty (revert to existing)
      // 3. The email prefix or 'User' (last-resort default)
      // Without this guard, a user who clears the field after their name was
      // already accidentally cleared (or paste-deletes everything) would
      // persist an empty display name. The render path has its own fallback
      // chain (tarn_service.js line ~824) but the SAVE path was bypassing it
      // by writing "" directly to localStorage. (Bug from 2026-05-11 UAT.)
      let newName = input.value.trim();
      if (!newName) {
        newName = (current && current.trim()) || (tarnService.getEmail() || '').split('@')[0] || 'User';
      }
      tarnService.displayName(newName);
      valueEl.textContent = newName;
      editBtn.innerHTML = SVG_EDIT;
      editBtn.classList.remove('save-active');
      // Update avatar initial
      const avatar = content.querySelector('.account-avatar');
      if (avatar) avatar.textContent = (newName[0] || 'U').toUpperCase();
    };

    editBtn.onclick = save;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
  });
}

// ============================================================================
// FRIENDS SECTION (#118 — issue 2 of the Friends rollout)
// ============================================================================

/**
 * Hydrate the Account → Friends section: list connections by label and list
 * outstanding issued invites with revoke buttons. Both are temporary
 * verification surfaces for issue 2; the proper drawer ships in issue 3.
 *
 * @param {HTMLElement} content
 */
async function refreshFriendsSection(content) {
  const connSection = content.querySelector('#accountConnectionsSection');
  const connList = content.querySelector('#accountConnectionsList');
  const invSection = content.querySelector('#accountPendingInvitesSection');
  const invList = content.querySelector('#accountPendingInvitesList');
  const status = content.querySelector('#accountFriendsStatus');
  if (!connSection || !connList || !invSection || !invList || !status) return;

  let connections = [];
  let invites = [];
  try {
    [connections, invites] = await Promise.all([
      friends.listConnections(),
      friends.listIssuedInvites(),
    ]);
  } catch (err) {
    status.style.display = 'block';
    status.textContent = "Couldn't load friends — try reopening Account.";
    console.warn('[AccountUI] friends fetch failed:', err.message);
    return;
  }
  status.style.display = 'none';

  // Connections list
  if (connections.length > 0) {
    connSection.style.display = 'block';
    connList.innerHTML = connections
      .map(c => {
        const label = (c.label && c.label.trim()) || (c.email ? c.email : c.share_pub.slice(0, 8));
        return `<li class="account-friend-row"><span class="account-friend-label">${escapeHtml(label)}</span></li>`;
      })
      .join('');
  } else {
    connSection.style.display = 'none';
    connList.innerHTML = '';
  }

  // Pending invites list
  const outstanding = invites.filter(i => !i.redeemed_at);

  // Note on zero-friends discoverability: the Account-screen "+ Add a friend"
  // button was REMOVED in #122 per the issue spec — the drawer is now the
  // canonical entry point. However, the drawer trigger is hidden when
  // zero friends, which creates a bootstrap chicken-and-egg problem for
  // first-time users. The parent FRIENDS.md spec calls out "Account → Add
  // a friend" as the zero-state discovery path; reconciling that with the
  // issue 3 removal is left to a follow-up surface (likely a dedicated
  // education sheet in #9 / #122 follow-up). For now we leave the section
  // empty in the zero-friends state — first invites can be sent via a
  // direct `/invite/...` link from a friend OR by opening the dev console
  // (alpha-cohort only). Document the gap so a reviewer doesn't think it
  // was an oversight.
  if (outstanding.length > 0) {
    invSection.style.display = 'block';
    invList.innerHTML = outstanding
      .map(inv => {
        const expires = inv.expires_at
          ? new Date(inv.expires_at * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })
          : '';
        const namePart = inv.display_name?.trim()
          ? `for ${escapeHtml(inv.display_name)}`
          : 'unnamed';
        return `
          <li class="account-friend-row" data-pending-token="${escapeHtml(inv.token_id)}">
            <span class="account-friend-label">Invite ${namePart}</span>
            <span class="account-friend-meta">${expires ? 'Expires ' + escapeHtml(expires) : ''}</span>
            <button type="button" class="btn-link account-friend-revoke" data-revoke-token="${escapeHtml(inv.token_id)}">Revoke</button>
          </li>
        `;
      })
      .join('');
    invList.querySelectorAll('[data-revoke-token]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tokenId = btn.dataset.revokeToken;
        btn.disabled = true;
        btn.textContent = 'Revoking…';
        try {
          await friends.revokeInvite(tokenId);
          await refreshFriendsSection(content);
        } catch (err) {
          console.error('[AccountUI] revoke failed:', err);
          btn.disabled = false;
          btn.textContent = 'Try again';
        }
      });
    });
  } else {
    invSection.style.display = 'none';
    invList.innerHTML = '';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ============================================================================
// ACCOUNT & SECURITY (recovery v2 — phase 2)
// ============================================================================

/**
 * Wire the Account & Security section: View account key, Replace account
 * key, and the passkeys list. Called once after the panel HTML is
 * rendered. The section is statically present in the panel markup; this
 * just attaches handlers and hydrates child blocks.
 *
 * #144: the manual-custody toggle is no longer surfaced in the UI. The
 * SDK wrappers `tarn_service.accountKey.enableKeyStorage` /
 * `disableKeyStorage` remain available for potential future re-exposure
 * as a power-user setting.
 *
 * @param {HTMLElement} content
 */
function wireAccountSecuritySection(content) {
  const viewBtn = content.querySelector('#viewAccountKeyBtn');
  const replaceBtn = content.querySelector('#replaceAccountKeyBtn');
  if (viewBtn) {
    viewBtn.addEventListener('click', () => startViewAccountKeyFlow());
  }
  if (replaceBtn) {
    replaceBtn.addEventListener('click', () => startReplaceAccountKeyFlow());
  }
  // #145: Unified change-credentials affordance. Single modal handles
  // username (email) and/or password changes — matches the SDK's single
  // `changeCredentials` call and the underlying cryptographic reality
  // (master_key = KDF(username, password); change either input and the DEK
  // chain re-wraps).
  const changeCredsBtn = content.querySelector('#changeCredentialsBtn');
  if (changeCredsBtn) {
    changeCredsBtn.addEventListener('click', () => startChangeCredentialsFlow(content));
  }
  // Registered passkeys block. Async because the support probe + initial
  // list() both touch the SDK.
  hydratePasskeysSection(content).catch(err =>
    console.warn('[AccountUI] passkeys hydrate failed:', err?.message || err)
  );
}

// ----------------------------------------------------------------------------
// Passkeys (recovery v2 — phase 3)
// ----------------------------------------------------------------------------

async function getPasskeysSupported() {
  return passkeySupportProbe.getPasskeysSupported();
}

function passkeySettingsDeps() {
  return {
    passkeys: tarnService.passkeys,
    getPasskeysSupported,
    createOverlay,
    confirmDialog,
    requestPasswordConfirmation,
    humanizeAccountKeyError,
    onWarn: (...args) => console.warn(...args),
  };
}

async function hydratePasskeysSection(content) {
  return hydratePasskeySettingsSection(content, passkeySettingsDeps());
}

/**
 * Translate an SDK error into a user-facing string for the Account &
 * Security section. `phraseFlow=true` means the error came from the
 * enable-storage path where the user typed a phrase, so a pinning failure
 * gets a phrase-specific message.
 */
function humanizeAccountKeyError(err, { phraseFlow }) {
  const msg = err?.message || '';
  // AccountKeyPinningError is detectable by name OR by the message text
  // when subclassing trips up the bundler. Be defensive.
  if (err?.name === 'AccountKeyPinningError' || /pinning|pin check|does not match/i.test(msg)) {
    return phraseFlow
      ? "That doesn't look like your account key. Check the spelling and try again."
      : 'Account-key check failed. Please try again.';
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

function accountKeyFlowDeps() {
  return {
    tarnService,
    confirmDialog,
    createOverlay,
    requestPasswordConfirmation,
    onWarn: (...args) => console.warn(...args),
  };
}

export async function startViewAccountKeyFlow(opts = {}) {
  return startViewAccountKeyFlowModule(opts, accountKeyFlowDeps());
}

async function startReplaceAccountKeyFlow() {
  return startReplaceAccountKeyFlowModule(accountKeyFlowDeps());
}

// ============================================================================
// CHANGE CREDENTIALS (issue #145 — unified username/password change)
// ============================================================================
//
// The SDK exposes a single `changeCredentials(newUsername, newPassword, opts)`
// call that re-wraps the DEK chain — there's no separate "change email" or
// "change password" path because the master key derives from BOTH inputs. The
// UI mirrors that: one modal, one flow, either or both fields editable.
//
// Step-up: the current password is verified app-side via `accountKey.view`,
// which (a) proves possession of the password and (b) returns the 24-word
// phrase the SDK needs to extend the recovery wrapping to the new gen.
//
// Passkey re-tap: if the account has registered passkeys, the SDK calls our
// per-credential handler during the change. Cancel from the handler surfaces
// as a "couldn't confirm all your passkeys" inline error.
//
// Forbidden: `acceptRecoveryGap: true`. Silently breaking recovery on a
// cancel is contra Bookish's product stance.

/**
 * Start the Change credentials flow. Renders a modal with current-password,
 * new-username (pre-filled), new-password, and confirm-new-password fields.
 * Save is disabled until at least one field differs from initial values.
 *
 * On success: clears password inputs, closes the modal, toasts, and re-renders
 * the Account panel so the header reflects any new email.
 *
 * @param {HTMLElement} content — the Account panel container, used to find
 *   the refresh hook after a successful change.
 */
async function startChangeCredentialsFlow(content) {
  const currentEmail = tarnService.getEmail() || '';
  await openChangeCredentialsDialog({
    currentEmail,
    onSuccess: async () => {
      // Re-render the Account panel so the header reflects the new email
      // (if it changed) and the avatar initial updates accordingly. Re-running
      // renderAccountPanel re-wires all the panel handlers including ours, so
      // the modal can re-open cleanly.
      try { renderAccountPanel(content); } catch (err) {
        console.warn('[AccountUI] panel refresh after credentials change failed:', err?.message || err);
      }
      showChangeCredentialsToast(content, 'Sign-in credentials updated.');
    },
  });
}

/**
 * Open the Change-credentials modal. Returns when the user dismisses
 * (cancel / backdrop / success). On success, `onSuccess` is awaited before
 * the overlay tears down so the panel re-render lands before the modal
 * disappears.
 *
 * @param {{
 *   currentEmail: string,
 *   onSuccess: () => Promise<void> | void,
 * }} opts
 * @returns {Promise<void>}
 */
function openChangeCredentialsDialog({ currentEmail, onSuccess }) {
  return new Promise((resolve) => {
    const overlay = createOverlay('change-credentials-overlay');
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true" aria-labelledby="changeCredentialsTitle">
        <h2 class="security-overlay-title" id="changeCredentialsTitle">Change username or password</h2>
        <p class="security-overlay-body">Your username and password together let you sign in. Change either field, or both &mdash; leave anything you don&rsquo;t want to change as-is.</p>
        <div class="form-group">
          <label for="ccCurrentPassword">Current password</label>
          <div class="password-field">
            <input type="password" id="ccCurrentPassword" autocomplete="current-password" placeholder="Your current password" />
            <button type="button" class="password-toggle" data-toggle-for="ccCurrentPassword" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>
        <div class="form-group">
          <label for="ccNewUsername">New username</label>
          <input type="email" id="ccNewUsername" autocomplete="email" />
        </div>
        <div class="form-group">
          <label for="ccNewPassword">New password</label>
          <div class="password-field">
            <input type="password" id="ccNewPassword" autocomplete="new-password" placeholder="Leave blank to keep current" />
            <button type="button" class="password-toggle" data-toggle-for="ccNewPassword" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>
        <div class="form-group" id="ccConfirmGroup" style="display:none;">
          <label for="ccConfirmPassword">Confirm new password</label>
          <div class="password-field">
            <input type="password" id="ccConfirmPassword" autocomplete="new-password" />
            <button type="button" class="password-toggle" data-toggle-for="ccConfirmPassword" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>
        <div class="security-overlay-error" data-error style="display:none;"></div>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>Cancel</button>
          <button type="button" class="btn primary" data-confirm disabled>Save changes</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const card = overlay.querySelector('.security-overlay-card');
    const currentPwInput = overlay.querySelector('#ccCurrentPassword');
    const newUsernameInput = overlay.querySelector('#ccNewUsername');
    const newPwInput = overlay.querySelector('#ccNewPassword');
    const confirmPwInput = overlay.querySelector('#ccConfirmPassword');
    const confirmGroup = overlay.querySelector('#ccConfirmGroup');
    const errorEl = overlay.querySelector('[data-error]');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');

    newUsernameInput.value = currentEmail;
    const initialUsername = currentEmail;

    const clearPasswordsFromDom = () => {
      currentPwInput.value = '';
      newPwInput.value = '';
      confirmPwInput.value = '';
    };

    const cleanup = () => {
      clearPasswordsFromDom();
      overlay.remove();
      resolve();
    };

    // Save-disabled-until-changed logic. Enable when:
    //   - new username differs from initial, OR
    //   - new password has any content.
    // The confirm-password field appears only when new-password is non-empty.
    const recomputeEnable = () => {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
      const newPwHasContent = newPwInput.value.length > 0;
      confirmGroup.style.display = newPwHasContent ? '' : 'none';
      if (!newPwHasContent) confirmPwInput.value = '';

      const usernameChanged = newUsernameInput.value !== initialUsername;
      const passwordChanged = newPwHasContent;
      const anyChange = usernameChanged || passwordChanged;
      const haveCurrentPw = currentPwInput.value.length > 0;
      confirmBtn.disabled = !(anyChange && haveCurrentPw);
    };

    [currentPwInput, newUsernameInput, newPwInput, confirmPwInput].forEach(el => {
      el.addEventListener('input', recomputeEnable);
    });

    // Password-toggle buttons (eye icon). Each toggles its associated input
    // by data-toggle-for; we share one handler.
    overlay.querySelectorAll('.password-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-toggle-for');
        const target = overlay.querySelector('#' + targetId);
        if (!target) return;
        const showing = target.type === 'text';
        target.type = showing ? 'password' : 'text';
        btn.innerHTML = showing ? SVG_EYE : SVG_EYE_OFF;
      });
    });

    cancelBtn.addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
    card.addEventListener('click', (e) => e.stopPropagation());

    // Enter on any field submits (when enabled).
    [currentPwInput, newUsernameInput, newPwInput, confirmPwInput].forEach(el => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !confirmBtn.disabled) {
          e.preventDefault();
          confirmBtn.click();
        }
      });
    });

    confirmBtn.addEventListener('click', async () => {
      const currentPassword = currentPwInput.value;
      const newUsernameRaw = newUsernameInput.value.trim();
      const newPasswordRaw = newPwInput.value;
      const confirmPasswordRaw = confirmPwInput.value;

      // Client-side validation: if a new password is provided, confirm-field
      // must match. Empty new password → confirm field is hidden + ignored.
      if (newPasswordRaw && newPasswordRaw !== confirmPasswordRaw) {
        errorEl.textContent = "New passwords don't match.";
        errorEl.style.display = 'block';
        return;
      }

      const usernameChanged = newUsernameRaw !== initialUsername;
      const passwordChanged = newPasswordRaw.length > 0;
      if (!usernameChanged && !passwordChanged) {
        // Save-disabled logic should prevent this, but be defensive.
        errorEl.textContent = "Nothing to change.";
        errorEl.style.display = 'block';
        return;
      }

      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      errorEl.style.display = 'none';
      errorEl.textContent = '';

      // Track passkey-cancel state across the per-credential handler so we
      // can surface a passkey-specific error after `changeCredentials`
      // resolves. The SDK swallows handler throws (treating them as
      // skip → stale credential), so we propagate the cancel signal via a
      // closure flag rather than relying on the throw to abort the SDK call.
      let passkeyCancelled = false;
      const passkeyTapHandler = async ({ credentialId, deviceLabel }) => {
        const confirmed = await showPasskeyTapPromptOverlay({
          deviceLabel: deviceLabel || truncateCredentialId(credentialId),
        });
        if (!confirmed) {
          passkeyCancelled = true;
          // Throw so the SDK marks this credential stale on the new gen
          // (matches the spec's "abort" intent at the per-credential
          // level). The wrapper afterwards surfaces a passkey-specific
          // error so the user knows what happened.
          throw new Error('User cancelled passkey re-tap');
        }
        return true;
      };

      try {
        await tarnService.changeCredentials({
          currentPassword,
          newUsername: usernameChanged ? newUsernameRaw : undefined,
          newPassword: passwordChanged ? newPasswordRaw : undefined,
          passkeyTapHandler,
        });
        if (passkeyCancelled) {
          // The credentials DID change server-side, but at least one passkey
          // wasn't re-confirmed (stale on new gen). Surface the spec's
          // passkey-cancel copy so the user knows to repair on next sign-in.
          errorEl.textContent = "Couldn't confirm all your passkeys. Try again when you have access to them.";
          errorEl.style.display = 'block';
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          clearPasswordsFromDom();
          // Trigger the success path anyway since credentials changed.
          // Keep the modal open so the user can dismiss after reading the
          // passkey notice — manual cancel will close.
          try { await onSuccess(); } catch (err) {
            console.warn('[AccountUI] onSuccess after partial passkey re-tap failed:', err?.message || err);
          }
          return;
        }
        clearPasswordsFromDom();
        // Run onSuccess BEFORE removing the overlay so the panel refresh
        // and toast land while the modal is still teardown-pending.
        try { await onSuccess(); } catch (err) {
          console.warn('[AccountUI] onSuccess after credentials change failed:', err?.message || err);
        }
        overlay.remove();
        resolve();
      } catch (err) {
        console.warn('[AccountUI] changeCredentials failed:', err?.message || err);
        errorEl.textContent = humanizeCredentialChangeError(err);
        errorEl.style.display = 'block';
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        clearPasswordsFromDom();
      }
    });

    requestAnimationFrame(() => currentPwInput.focus({ preventScroll: true }));
  });
}

/**
 * Per-credential passkey-tap prompt. Renders a small overlay above the
 * credentials-change modal asking the user to confirm tapping the specified
 * device's passkey; resolves true on confirm, false on cancel/backdrop.
 *
 * @param {{ deviceLabel: string }} opts
 * @returns {Promise<boolean>}
 */
function showPasskeyTapPromptOverlay({ deviceLabel }) {
  return new Promise((resolve) => {
    const overlay = createOverlay('passkey-tap-overlay');
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true">
        <h2 class="security-overlay-title">Confirm your passkey</h2>
        <p class="security-overlay-body">Tap your <strong>${escapeHtml(deviceLabel)}</strong> passkey so it keeps working with your new sign-in.</p>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>Skip this passkey</button>
          <button type="button" class="btn primary" data-confirm>Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const card = overlay.querySelector('.security-overlay-card');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    confirmBtn.addEventListener('click', () => cleanup(true));
    cancelBtn.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    card.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrame(() => confirmBtn.focus({ preventScroll: true }));
  });
}

/**
 * Show a transient success toast after a successful credential change.
 * Re-uses the passkey-success affirmation rendering for visual consistency,
 * but as a sibling above the credentials block so it sits in-section.
 */
function showChangeCredentialsToast(content, message) {
  const block = content.querySelector('#accountCredentialsBlock');
  if (!block) return;
  let el = content.querySelector('.account-credentials-success');
  if (!el) {
    el = document.createElement('div');
    el.className = 'account-credentials-success account-passkeys-success';
    el.setAttribute('role', 'status');
    block.insertBefore(el, block.firstChild);
  }
  el.textContent = '✓ ' + message;
  el.style.display = 'block';
  if (el._dismissTimer) clearTimeout(el._dismissTimer);
  el._dismissTimer = setTimeout(() => {
    el.style.display = 'none';
    el._dismissTimer = null;
  }, 3500);
}

/**
 * Translate an SDK error from the unified `changeCredentials` flow into a
 * user-facing string. Sibling of `humanizeAccountKeyError` /
 * `humanizePasskeyError`; covers the credentials-change-specific cases
 * (combination-in-use 409, passkey re-tap missing handler, etc.) before
 * falling back to the shared account-key error mapping.
 */
function humanizeCredentialChangeError(err) {
  const msg = err?.message || '';
  // 409 Conflict on the new credential lookup key — the username + password
  // combination already maps to an existing account. Per the spec, surface
  // the combination-aware copy (don't soften — it's intentional).
  if (
    /new_credential_lookup_key.*already in use/i.test(msg) ||
    /credential_lookup_key.*409/i.test(msg) ||
    /409/.test(msg) && /lookup/i.test(msg) ||
    /credential.*conflict|lookup.*conflict|combination.*in use|conflict.*credential/i.test(msg)
  ) {
    return 'That username and password combination is already in use. Try a different password.';
  }
  // Model A: step-up `accountKey.view` returns `no_account_key_stored`.
  if (/no_account_key_stored/i.test(msg)) {
    return "Your account key isn't stored on our servers. Contact support if you need to change credentials.";
  }
  // Passkey re-tap missing handler — SDK throws when the account has
  // passkeys and we forgot to pass one. Caught defensively.
  if (/passkeyTapHandler/i.test(msg)) {
    return "Couldn't confirm all your passkeys. Try again when you have access to them.";
  }
  // Wrong current password (from step-up). Step-up errors look like
  // "step-up auth failed" or "invalid password" / "credential" — share
  // the same mapping as the View flow's password prompt.
  if (/step-up|challenge|wrong password|invalid password|credential/i.test(msg)) {
    return 'Current password is incorrect.';
  }
  if (/network|fetch|timeout|offline/i.test(msg)) {
    return "Couldn't reach our servers. Check your connection and try again.";
  }
  return "Couldn't update credentials. Try again.";
}

// ----------------------------------------------------------------------------
// Inline modal helpers — password prompt, confirm/alert dialog, enable-storage
// inputs. Each renders a card on top of an overlay sibling to the account
// modal so the panel stays mounted and visible underneath.
//
// Password handling: the input value is captured into a local variable on
// submit and the input element is cleared (`.value = ''`) before the
// promise resolves. Never logged, never persisted.
// ----------------------------------------------------------------------------

function createOverlay(extraClass = '') {
  const overlay = document.createElement('div');
  overlay.className = 'security-overlay';
  if (extraClass) overlay.classList.add(extraClass);
  return overlay;
}

/**
 * Show a password-prompt modal.
 *
 * Two shapes:
 *   1. With `submit`: the dialog stays open across submit failures. On
 *      success the dialog closes and the promise resolves with whatever
 *      `submit(password)` resolved to. On failure an inline error appears
 *      inside the dialog and the user can edit + retry. Cancel / backdrop
 *      dismiss resolves `null`.
 *   2. Without `submit`: classic prompt — resolves with the password
 *      string on confirm, `null` on cancel.
 *
 * Password handling: the input value is captured into a local on confirm,
 * the input element is cleared before resolving. Never logged, never
 * persisted.
 *
 * @template T
 * @param {{
 *   title: string,
 *   body: string,
 *   confirmLabel?: string,
 *   submit?: (password: string) => Promise<T>,
 * }} opts
 * @returns {Promise<string | T | null>}
 */
function requestPasswordConfirmation({ title, body, confirmLabel = 'Continue', submit }) {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true">
        <h2 class="security-overlay-title">${escapeHtml(title)}</h2>
        <p class="security-overlay-body">${escapeHtml(body)}</p>
        <div class="form-group">
          <label for="securityPasswordInput">Password</label>
          <div class="password-field">
            <input type="password" id="securityPasswordInput" autocomplete="current-password" placeholder="Your password" />
            <button type="button" class="password-toggle" tabindex="-1">${SVG_EYE}</button>
          </div>
        </div>
        <div class="security-overlay-error" data-error style="display:none;"></div>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>Cancel</button>
          <button type="button" class="btn primary" data-confirm disabled>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const card = overlay.querySelector('.security-overlay-card');
    const input = overlay.querySelector('#securityPasswordInput');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    const toggleBtn = overlay.querySelector('.password-toggle');
    const errorEl = overlay.querySelector('[data-error]');

    const cleanupAndResolve = (value) => {
      // Clear the input before resolving so the password doesn't sit in
      // the DOM after the overlay is removed.
      if (input) input.value = '';
      overlay.remove();
      resolve(value);
    };

    input.addEventListener('input', () => {
      confirmBtn.disabled = input.value.length === 0;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) {
        e.preventDefault();
        confirmBtn.click();
      }
    });

    confirmBtn.addEventListener('click', async () => {
      const pw = input.value;
      if (!submit) {
        cleanupAndResolve(pw);
        return;
      }
      // Run the submit handler with the dialog still open. On error,
      // show inline error and keep the dialog mounted so the user can
      // edit and retry without re-opening.
      confirmBtn.disabled = true;
      errorEl.style.display = 'none';
      errorEl.textContent = '';
      try {
        const result = await submit(pw);
        cleanupAndResolve(result);
      } catch (err) {
        console.warn('[AccountUI] password-prompt submit failed:', err?.message || err);
        errorEl.textContent = humanizeAccountKeyError(err, { phraseFlow: false });
        errorEl.style.display = 'block';
        confirmBtn.disabled = input.value.length === 0;
      }
    });
    cancelBtn.addEventListener('click', () => cleanupAndResolve(null));

    toggleBtn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggleBtn.innerHTML = showing ? SVG_EYE : SVG_EYE_OFF;
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanupAndResolve(null);
    });
    // Click on card stops bubbling so the backdrop handler doesn't fire.
    card.addEventListener('click', (e) => e.stopPropagation());

    // Focus the input on the next frame.
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  });
}

/**
 * Confirm dialog (yes/no). Resolves true on confirm, false on cancel.
 *
 * @param {{ title: string, body: string, confirmLabel?: string, cancelLabel?: string }} opts
 * @returns {Promise<boolean>}
 */
function confirmDialog({ title, body, confirmLabel = 'Continue', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    overlay.innerHTML = `
      <div class="security-overlay-card" role="dialog" aria-modal="true">
        <h2 class="security-overlay-title">${escapeHtml(title)}</h2>
        <p class="security-overlay-body">${escapeHtml(body)}</p>
        <div class="security-overlay-actions">
          <button type="button" class="btn secondary" data-cancel>${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn primary" data-confirm>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');
    const card = overlay.querySelector('.security-overlay-card');
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    confirmBtn.addEventListener('click', () => cleanup(true));
    cancelBtn.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    card.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrame(() => confirmBtn.focus({ preventScroll: true }));
  });
}

/**
 * Normalize a pasted 24-word phrase. Tolerates:
 *   - Leading/trailing whitespace
 *   - Newlines / mixed whitespace between words
 *   - Numbered prefixes per line ("1. word", "01) word", "(1) word")
 *   - Mixed case
 *
 * Result: lowercase words separated by single spaces. The SDK's own
 * `validateAccountKey` runs a stricter NFKD/lowercase normalization
 * afterwards, so this is purely a friendliness layer for paste UX.
 */
function normalizePastedPhrase(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // Strip numbered list prefixes (e.g. "1.", "01)", "(1)") at the start of
  // each whitespace-separated chunk.
  return raw
    .replace(/[ \t]+/g, ' ')                 // tabs / nbsp → space
    .split(/\s+/)
    .map(tok => tok.replace(/^[\(\[]?\d{1,2}[\)\.\]:\-]?$/i, ''))  // pure number tokens → drop
    .map(tok => tok.replace(/^[\(\[]?\d{1,2}[\)\.\]:\-]/, ''))     // "1." / "(1)" prefix → strip
    .filter(Boolean)
    .join(' ')
    .trim()
    .toLowerCase();
}

// ============================================================================
// CSV EXPORT
// ============================================================================

function exportBooksToCSV() {
  const books = window.bookishCache?.getAllActive?.();
  if (!books || typeof books.then !== 'function') {
    alert('No books to export');
    return;
  }

  books.then(entries => {
    if (!entries.length) { alert('No books to export'); return; }

    const headers = ['Title', 'Author', 'Date Read', 'Rating', 'Format', 'Notes'];
    const rows = entries.map(e => [
      csvEscape(e.title || ''),
      csvEscape(e.author || ''),
      csvEscape(msToDateInputUtc(e.dateRead)),
      e.rating || '',
      csvEscape(e.format || ''),
      csvEscape(e.notes || ''),
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bookish-export.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}

function csvEscape(str) {
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Expose for app.js
window.accountUI = {
  openAccountModal,
  handleSignIn: () => {
    openAccountModal('signin');
  },
};

// Testing seam — exposed for unit tests of pure helpers. Not part of the
// public surface; do NOT import from app code.
export const __test__ = {
  humanizePasskeyDate,
  suggestDeviceLabel,
  truncateCredentialId,
  normalizePastedPhrase,
  humanizePasskeySigninError,
  humanizeCredentialChangeError,
  promptStalePasskeyRepair,
  showPasskeyAddedAffirmation,
  resetPasskeysSupportedCache: () => passkeySupportProbe.resetPasskeysSupportedCache(),
};
