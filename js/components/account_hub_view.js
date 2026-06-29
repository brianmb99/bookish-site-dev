import { escapeHtml } from './book_card.js';
import {
  renderSubscriptionSection,
  wireSubscriptionSection,
} from './account_subscription_section.js';

export function renderAccountHeaderHtml({ email, displayName, initial, passkeyOnly = false }) {
  // Passkey-only sessions (#224) carry no email/display-name client-side, so
  // we render an explicit "Passkey session" placeholder under the name slot
  // instead of an empty/stale email line. Same visual style as the email row.
  const subline = passkeyOnly ? 'Passkey session' : (email || '');
  return `
    <div class="account-panel-header">
      <div class="account-avatar">${escapeHtml(initial)}</div>
      <div class="account-panel-info">
        <div class="account-panel-name">
          <span id="displayNameValue">${escapeHtml(displayName)}</span>
        </div>
        <div class="account-panel-email">${escapeHtml(subline)}</div>
      </div>
    </div>
  `;
}

export function renderAccountHub(content, {
  identity,
  subscription,
  activeEntryCount = 0,
  onView,
  onLogout,
  onError = () => {},
  setTimeoutRef = setTimeout,
} = {}) {
  content.innerHTML = `
    <div class="auth-form account-hub">
      ${renderAccountHeaderHtml(identity)}

      <div class="account-panel-tagline">Private, permanent, yours.</div>

      ${renderSubscriptionSection({ subscription, activeEntryCount })}

      <div class="account-hub-list" aria-label="Account settings">
        <button type="button" class="account-hub-row" data-account-view="security">
          <span class="account-hub-row-main">
            <span class="account-hub-row-title">Account &amp; Security</span>
            <span class="account-hub-row-desc">Account key, passkeys, username and password</span>
          </span>
          <span class="account-hub-chevron" aria-hidden="true">&rarr;</span>
        </button>
        <button type="button" class="account-hub-row" data-account-view="friends">
          <span class="account-hub-row-main">
            <span class="account-hub-row-title">Friends</span>
            <span class="account-hub-row-desc">Header visibility, connections and pending invites</span>
          </span>
          <span class="account-hub-chevron" aria-hidden="true">&rarr;</span>
        </button>
        <!-- "Permanent Archive" row hidden pre-launch: the subview shipped a
             hard-coded placeholder Arweave URL (fake txid) shown to every user,
             which undercuts the core trust claim. Restore this row once a real
             per-user archive link exists. The CSV "Data Export" below + the
             standalone forever.html recovery page remain the real export paths.
             View + routing left dormant in account_archive_view.js / account_ui.js. -->
        <button type="button" class="account-hub-row" data-account-view="export">
          <span class="account-hub-row-main">
            <span class="account-hub-row-title">Data Export</span>
            <span class="account-hub-row-desc">Download a CSV copy of your library</span>
          </span>
          <span class="account-hub-chevron" aria-hidden="true">&rarr;</span>
        </button>
      </div>

      <div class="account-actions">
        <button id="logoutBtn" class="btn account-signout">
          Sign Out
        </button>
      </div>
    </div>
  `;

  wireSubscriptionSection(content, { subscription, onError, setTimeoutRef });
  wireAccountHubRows(content, { onView });
  wireLogout(content, { onLogout });
}

export function wireLogout(content, { onLogout } = {}) {
  content.querySelector('#logoutBtn')?.addEventListener('click', async () => {
    await onLogout?.();
  });
}

function wireAccountHubRows(content, { onView } = {}) {
  content.querySelectorAll('.account-hub-row[data-account-view]').forEach(btn => {
    btn.addEventListener('click', () => onView?.(btn.dataset.accountView));
  });
}
