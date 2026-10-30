// storage_protection.js — Keep this device's Bookish data from being evicted.
//
// WebKit's tracking prevention deletes a site's script-written storage (the
// signed-in session, cached books, and books saved before creating an
// account) after seven days of browser use without a visit. A Home Screen
// web app has its own storage, separate from the browser's, and is not
// swept. So once someone has something to lose, a browser tab on iPhone or
// iPad shows a banner asking them to add Bookish to the Home Screen.
// Guests are asked to create an account first, because their books would
// not follow them out of the browser's storage.
//
// Every platform also asks for persistent storage once there is data. The
// browser decides: Safari and Chrome grant or deny silently (installed
// apps are favored), Firefox asks the user.
//
// Public surface:
//   - refresh()                   — re-evaluate after boot, sign-in,
//                                   sign-out, or a library change.
//   - shouldPrompt(...)           — banner gating, pure.
//   - requestPersistentStorage()  — once per page load.

import * as tarnService from './tarn_service.js';
import { debugLog } from './debug_log.js';

const DISMISSED_AT_KEY = 'bookish.homeScreenPrompt.dismissedAt';
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
const BANNER_ID = 'homeScreenPrompt';

const SVG_HOME = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M12 7v7"/><path d="M8.5 10.5h7"/></svg>`;
const SVG_CLOSE = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;

const COPY = {
  signedIn: {
    title: 'Add Bookish to your Home Screen',
    body: 'Browser tabs on iPhone and iPad can sign you out after a week without a visit. From the Home Screen, you stay signed in. Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.',
  },
  guest: {
    title: 'Keep your books',
    body: 'Browser tabs on iPhone and iPad can delete saved books after a week without a visit. Create an account to back them up, then tap <strong>Share</strong> and <strong>Add to Home Screen</strong>.',
  },
};

let persistRequest = null;

export function isAppleMobile(nav = globalThis.navigator) {
  const ua = nav?.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS Safari reports a Mac user agent by default.
  return /Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1;
}

export function isStandalone(win = globalThis.window) {
  if (win?.navigator?.standalone === true) return true;
  return !!win?.matchMedia?.('(display-mode: standalone)').matches;
}

/**
 * @param {{ signedIn: boolean, bookCount: number, win?: Window, now?: number }} state
 * @returns {boolean}
 */
export function shouldPrompt({ signedIn, bookCount, win = globalThis.window, now = Date.now() }) {
  if (!signedIn && !(bookCount > 0)) return false;
  if (!isAppleMobile(win?.navigator) || isStandalone(win)) return false;
  let dismissedAt = 0;
  try { dismissedAt = Number(win.localStorage.getItem(DISMISSED_AT_KEY)) || 0; } catch {}
  return !(dismissedAt && now - dismissedAt < SNOOZE_MS);
}

/**
 * Ask the browser to keep this origin's storage out of eviction. Runs at
 * most once per page load; resolves to whether storage is persistent.
 *
 * @param {StorageManager} [storage]
 * @returns {Promise<boolean>}
 */
export function requestPersistentStorage(storage = globalThis.navigator?.storage) {
  if (!persistRequest) {
    persistRequest = (async () => {
      if (typeof storage?.persist !== 'function') return false;
      try {
        if (typeof storage.persisted === 'function' && await storage.persisted()) return true;
        return (await storage.persist()) === true;
      } catch {
        return false;
      }
    })();
  }
  return persistRequest;
}

export function refresh() {
  const signedIn = tarnService.isLoggedIn();
  let bookCount = 0;
  try { bookCount = window.bookishApp?.getActiveEntryCount?.() ?? 0; } catch {}

  if (signedIn || bookCount > 0) {
    requestPersistentStorage().then(persisted => debugLog('[Bookish:Storage] persistent:', persisted));
  }

  if (shouldPrompt({ signedIn, bookCount })) showBanner(signedIn ? 'signedIn' : 'guest');
  else hideBanner();
}

export function isBannerVisible() {
  return !!document.getElementById(BANNER_ID)?.classList.contains('is-visible');
}

function dismiss() {
  try { localStorage.setItem(DISMISSED_AT_KEY, String(Date.now())); } catch {}
  hideBanner();
}

function getOrCreateBanner() {
  let el = document.getElementById(BANNER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = BANNER_ID;
  el.className = 'home-screen-prompt';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Add Bookish to your Home Screen');
  el.innerHTML = `
    <div class="home-screen-prompt-content">
      <div class="home-screen-prompt-icon">${SVG_HOME}</div>
      <div class="home-screen-prompt-text">
        <div class="home-screen-prompt-title"></div>
        <div class="home-screen-prompt-body"></div>
      </div>
      <div class="home-screen-prompt-actions">
        <button type="button" class="btn primary" id="homeScreenPromptSignUpBtn">Create account</button>
      </div>
      <button type="button" class="home-screen-prompt-close" id="homeScreenPromptCloseBtn" aria-label="Dismiss">${SVG_CLOSE}</button>
    </div>
  `;
  el.querySelector('#homeScreenPromptSignUpBtn').addEventListener('click', () => {
    window.accountUI?.openAccountModal?.();
  });
  el.querySelector('#homeScreenPromptCloseBtn').addEventListener('click', dismiss);

  // Same slot as the sign-up nudge and the account-key reminder.
  const anchor = document.getElementById('accountNudgeBanner');
  if (anchor?.parentNode) {
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
  } else {
    const app = document.getElementById('app');
    if (app) app.insertBefore(el, app.firstChild);
    else document.body.insertBefore(el, document.body.firstChild);
  }
  return el;
}

function showBanner(variant) {
  const el = getOrCreateBanner();
  el.dataset.variant = variant;
  el.querySelector('.home-screen-prompt-title').textContent = COPY[variant].title;
  el.querySelector('.home-screen-prompt-body').innerHTML = COPY[variant].body;
  el.querySelector('.home-screen-prompt-actions').hidden = variant !== 'guest';
  el.classList.add('is-visible');
  // The guest variant already asks for an account.
  if (variant === 'guest') {
    const nudge = document.getElementById('accountNudgeBanner');
    if (nudge) nudge.style.display = 'none';
  }
}

function hideBanner() {
  document.getElementById(BANNER_ID)?.classList.remove('is-visible');
}

export const __test__ = {
  DISMISSED_AT_KEY,
  SNOOZE_MS,
  BANNER_ID,
  resetPersistRequest() { persistRequest = null; },
};
