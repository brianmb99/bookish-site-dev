// friends_router.js — URL routing for the Friends invite link.
//
// Three responsibilities:
//   1. On initial page load, detect /invite/:token_id and stash the
//      parameters (token_id from path, payload_key from URL fragment).
//      Clean the URL so a reload doesn't keep re-firing the modal.
//   2. After the user is authenticated (session restore, login, or fresh
//      signup completion), open the accept-invite modal with the stashed
//      params if any. Idempotent — clears stash on success.
//   3. If the user lands on /invite/:token_id while logged out, leave the
//      stash in place across the signup/sign-in redirect so the same flow
//      kicks in once auth completes.
//
// Friends Issue 2 (Surface 6).

import * as friends from './friends.js';
import * as tarnService from './tarn_service.js';

let _initialCheckDone = false;

/**
 * Inspect the current URL for an invite link. If it matches, stash the
 * params in sessionStorage and rewrite the URL to '/' so a reload doesn't
 * re-trigger. Idempotent — safe to call multiple times during init.
 *
 * Call once on app startup, before auth state is consulted.
 */
export function captureInviteFromUrl() {
  if (_initialCheckDone) return;
  _initialCheckDone = true;
  if (typeof window === 'undefined') return;
  const parsed = friends.parseInviteUrl(window.location);
  if (!parsed) return;
  friends.stashPendingInvite(parsed);
  // Clean the URL so a refresh doesn't keep firing. Use replaceState so we
  // don't add a back-stack entry.
  try {
    window.history.replaceState(null, '', '/');
  } catch {
    // history may be unavailable in odd embeds; the stash is the real bridge.
  }
}

/**
 * If a pending invite is stashed AND the user is logged in, open the
 * accept-invite modal. Lazy-imports the modal so we don't pay its cost on
 * pages that never see an invite.
 *
 * Call after each auth-state change: post `tarnService.init()`, post
 * `tarnService.login()`, and post the signup-completed handoff.
 */
export async function maybeOpenPendingAcceptModal() {
  const params = friends.readPendingInvite();
  if (!params) return;
  if (!tarnService.isLoggedIn()) {
    // The invite stays stashed across the auth flow; we'll be called again
    // once the user is signed in.
    return;
  }
  try {
    const mod = await import('../components/accept-invite-modal.js');
    await mod.openAcceptInviteModal(params);
  } catch (err) {
    console.error('[Bookish:FriendsRouter] failed to open accept modal:', err);
  }
}

/**
 * If a pending invite is stashed AND the user is logged out, open the
 * account modal so the user can sign up or sign in. The accept modal will
 * fire automatically once auth completes (via the post-auth hooks in
 * account_ui.js). Returns true if the prompt was shown.
 *
 * @returns {Promise<boolean>}
 */
export async function maybePromptSignupForInvite() {
  if (tarnService.isLoggedIn()) return false;
  const params = friends.readPendingInvite();
  if (!params) return false;
  // window.accountUI is wired up by an async import in app.js's
  // initAccount(), which races with initCacheLayer() that calls us. Wait
  // up to ~3s for it to appear.
  const accountUI = await waitForAccountUI(3000);
  if (accountUI && typeof accountUI.openAccountModal === 'function') {
    try {
      // Default to the create-account view — invite redemption is most
      // commonly a fresh-signup moment. Users who already have an account
      // can switch to sign-in from inside the modal.
      await accountUI.openAccountModal();
      return true;
    } catch (err) {
      console.warn('[Bookish:FriendsRouter] failed to open account modal:', err.message);
    }
  }
  return false;
}

function waitForAccountUI(timeoutMs) {
  if (typeof window === 'undefined') return null;
  if (window.accountUI) return Promise.resolve(window.accountUI);
  return new Promise(resolve => {
    const start = Date.now();
    const tick = () => {
      if (window.accountUI) { resolve(window.accountUI); return; }
      if (Date.now() - start > timeoutMs) { resolve(null); return; }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * Convenience: capture + (optionally) open in one call. Used at app
 * startup. Returns whether a pending invite was found.
 *
 * @returns {Promise<boolean>}
 */
export async function handleInviteOnStartup() {
  captureInviteFromUrl();
  const stashed = friends.readPendingInvite();
  if (!stashed) return false;
  if (tarnService.isLoggedIn()) {
    await maybeOpenPendingAcceptModal();
  } else {
    await maybePromptSignupForInvite();
  }
  return true;
}
