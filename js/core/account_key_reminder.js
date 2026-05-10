// account_key_reminder.js — Engagement-milestone reminder for unsaved
// account keys (recovery v2 — Phase 5).
//
// A gentle in-app banner that nudges Model B users who have accumulated
// some engagement (≥ MIN_BOOKS books, ≥ MIN_SESSIONS sessions) but have
// not yet confirmed they saved their account key. Suppressed permanently
// once they tap "I have it" or successfully view the key, and
// suppressed for the current session if they tap the X.
//
// Public surface:
//   - init()              — call once after sign-in / session-resume.
//                           Increments the session counter (idempotent
//                           within a page life), mounts the banner if
//                           shouldShow() returns true.
//   - shouldShow()        — returns true iff all gating conditions hold.
//   - markSaved()         — permanent suppression (localStorage flag).
//   - dismissForSession() — session-scoped suppression (sessionStorage).
//   - reset()             — clear all flags + counter. Call on logout.
//
// LocalStorage keys (under bookish.* namespace):
//   - bookish.accountKey.sessionCount    integer
//   - bookish.accountKey.firstSessionAt  ISO timestamp (informational)
//   - bookish.accountKey.saved           "1" when permanently suppressed
//
// SessionStorage keys:
//   - bookish.accountKey.sessionInited        guards init() idempotency
//   - bookish.accountKey.dismissedThisSession set when X is tapped
//
// The thresholds are constants at the top of the module so they can be
// tuned without spelunking through conditionals.

import * as tarnService from './tarn_service.js';

// ─── Tunable thresholds ──────────────────────────────────────────────
const MIN_SESSIONS = 2;  // User must be on at least their 2nd session.
const MIN_BOOKS    = 5;  // User must have at least 5 active books.

// ─── Storage keys ────────────────────────────────────────────────────
const LS_SESSION_COUNT     = 'bookish.accountKey.sessionCount';
const LS_FIRST_SESSION_AT  = 'bookish.accountKey.firstSessionAt';
const LS_SAVED             = 'bookish.accountKey.saved';
const SS_SESSION_INITED    = 'bookish.accountKey.sessionInited';
const SS_DISMISSED         = 'bookish.accountKey.dismissedThisSession';

// ─── DOM ids ─────────────────────────────────────────────────────────
const BANNER_ID = 'accountKeyReminder';

// SVG icons inlined to keep this module self-contained.
const SVG_KEY = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 3 3"/><path d="m15 8 3 3"/></svg>`;
const SVG_CLOSE = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;

// ─── Internal helpers ────────────────────────────────────────────────

function readSessionCount() {
  const raw = localStorage.getItem(LS_SESSION_COUNT);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function getActiveBookCount() {
  try {
    return window.bookishApp?.getActiveEntryCount?.() ?? 0;
  } catch {
    return 0;
  }
}

function isLoggedIn() {
  try {
    return !!tarnService.isLoggedIn?.();
  } catch {
    return false;
  }
}

function isModelB() {
  // accountKey.isStored() returns true (Model B), false (Model A), or
  // null (auth round-trip not yet complete). Treat null as "don't show
  // yet"; we'll re-evaluate next session.
  try {
    return tarnService.accountKey?.isStored?.() === true;
  } catch {
    return false;
  }
}

function isPermanentlySuppressed() {
  return localStorage.getItem(LS_SAVED) === '1';
}

function isDismissedThisSession() {
  return sessionStorage.getItem(SS_DISMISSED) === '1';
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Increment the session counter (once per page life), then evaluate
 * whether to render the banner. Safe to call multiple times in the same
 * page life — the second call is a no-op for the counter and re-runs
 * the render evaluation.
 */
export function init() {
  // Idempotent counter bump per page life. The sessionStorage guard
  // survives in-tab navigations and tab-restore but is fresh on full
  // reload, which is what we want for the "session" definition.
  if (sessionStorage.getItem(SS_SESSION_INITED) !== '1') {
    sessionStorage.setItem(SS_SESSION_INITED, '1');
    const next = readSessionCount() + 1;
    localStorage.setItem(LS_SESSION_COUNT, String(next));
    if (!localStorage.getItem(LS_FIRST_SESSION_AT)) {
      localStorage.setItem(LS_FIRST_SESSION_AT, new Date().toISOString());
    }
  }

  if (shouldShow()) {
    showBanner();
  } else {
    hideBanner();
  }
}

/**
 * Whether all gating conditions are currently met. Returns false on any
 * negative answer; null/unknown states (notably `accountKey.isStored() ===
 * null` on a fresh client) also return false.
 */
export function shouldShow() {
  if (!isLoggedIn()) return false;
  if (!isModelB()) return false;
  if (isPermanentlySuppressed()) return false;
  if (isDismissedThisSession()) return false;
  if (readSessionCount() < MIN_SESSIONS) return false;
  if (getActiveBookCount() < MIN_BOOKS) return false;
  return true;
}

/**
 * Permanently suppress the banner. Called when the user has either
 * confirmed "I have it" or successfully completed the View flow.
 */
export function markSaved() {
  localStorage.setItem(LS_SAVED, '1');
  hideBanner();
}

/**
 * Suppress the banner for the current session only. Called when the
 * user dismisses via the X button. Re-evaluates next session.
 */
export function dismissForSession() {
  sessionStorage.setItem(SS_DISMISSED, '1');
  hideBanner();
}

/**
 * Clear all reminder state (counter, first-session timestamp, saved
 * flag, session-scoped flags). Called on logout so a different user
 * signing in on the same browser is evaluated freshly.
 */
export function reset() {
  localStorage.removeItem(LS_SESSION_COUNT);
  localStorage.removeItem(LS_FIRST_SESSION_AT);
  localStorage.removeItem(LS_SAVED);
  sessionStorage.removeItem(SS_SESSION_INITED);
  sessionStorage.removeItem(SS_DISMISSED);
  hideBanner();
}

// ─── Banner rendering ────────────────────────────────────────────────

function getOrCreateBanner() {
  let el = document.getElementById(BANNER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = BANNER_ID;
  el.className = 'account-key-reminder';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Account key reminder');
  // Visibility is controlled via the .is-visible class. CSS sets the
  // default `display:none`; adding the class swaps to `display:flex` and
  // fades opacity in.
  el.innerHTML = `
    <div class="account-key-reminder-content">
      <div class="account-key-reminder-icon">${SVG_KEY}</div>
      <div class="account-key-reminder-text">
        <div class="account-key-reminder-title">Save your account key</div>
        <div class="account-key-reminder-body">Your library is growing. Make sure you can keep it forever.</div>
      </div>
      <div class="account-key-reminder-actions">
        <button type="button" class="btn primary" id="reminderViewBtn">View now</button>
        <button type="button" class="btn secondary" id="reminderSavedBtn">I have it</button>
      </div>
      <button type="button" class="account-key-reminder-close" id="reminderCloseBtn" aria-label="Dismiss">${SVG_CLOSE}</button>
    </div>
  `;
  // Mount the banner above the main book list. The existing
  // #accountNudgeBanner sits between <header> and the book grid; place
  // ours immediately after it so both transient banners share the same
  // slot (only one of the two is ever visible to a given user — the
  // signup-nudge is for logged-out users with ≥3 books, this one is
  // for logged-in users).
  const anchor = document.getElementById('accountNudgeBanner');
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
  } else {
    // Fallback: drop it at the top of #app so it doesn't disappear under
    // a sub-area whose visibility is conditionally toggled.
    const app = document.getElementById('app');
    if (app) app.insertBefore(el, app.firstChild);
    else document.body.insertBefore(el, document.body.firstChild);
  }
  wireBannerHandlers(el);
  return el;
}

function wireBannerHandlers(el) {
  const viewBtn = el.querySelector('#reminderViewBtn');
  const savedBtn = el.querySelector('#reminderSavedBtn');
  const closeBtn = el.querySelector('#reminderCloseBtn');
  if (viewBtn) {
    viewBtn.addEventListener('click', () => {
      // Lazy import keeps the reminder module free of any direct
      // dependency on account_ui.js (which itself imports tarn_service).
      // The View flow accepts an optional onCompleted callback added in
      // Phase 5 — fired only on a successful Done tap.
      import('../account_ui.js').then((mod) => {
        if (typeof mod.startViewAccountKeyFlow !== 'function') {
          console.warn('[AccountKeyReminder] startViewAccountKeyFlow missing');
          return;
        }
        mod.startViewAccountKeyFlow({ onCompleted: () => markSaved() });
      }).catch(err => {
        console.warn('[AccountKeyReminder] failed to open View flow:', err?.message || err);
      });
    });
  }
  if (savedBtn) {
    savedBtn.addEventListener('click', () => {
      markSaved();
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      dismissForSession();
    });
  }
}

function showBanner() {
  const el = getOrCreateBanner();
  // Strip any leftover inline display from earlier versions / tests so the
  // class-toggled rule wins.
  if (el.style.display) el.style.display = '';
  el.classList.add('is-visible');
}

function hideBanner() {
  const el = document.getElementById(BANNER_ID);
  if (!el) return;
  if (el.style.display) el.style.display = '';
  el.classList.remove('is-visible');
}

// Test-only helpers exposed on the namespace for unit tests. Consumers
// outside tests should not rely on these — they're internal.
export const __test__ = {
  readSessionCount,
  getActiveBookCount,
  LS_SESSION_COUNT,
  LS_FIRST_SESSION_AT,
  LS_SAVED,
  SS_SESSION_INITED,
  SS_DISMISSED,
  BANNER_ID,
  MIN_SESSIONS,
  MIN_BOOKS,
};
