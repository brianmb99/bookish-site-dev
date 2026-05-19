import { escapeHtml } from './book_card.js';
import {
  renderSubscriptionSection,
  wireSubscriptionSection,
} from './account_subscription_section.js';

export function renderAccountHeaderHtml({ email, displayName, initial }) {
  return `
    <div class="account-panel-header">
      <div class="account-avatar">${escapeHtml(initial)}</div>
      <div class="account-panel-info">
        <div class="account-panel-name">
          <span id="displayNameValue">${escapeHtml(displayName)}</span>
        </div>
        <div class="account-panel-email">${escapeHtml(email)}</div>
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

      <div class="account-panel-tagline">Private. Permanent. Yours.</div>

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
        <button type="button" class="account-hub-row" data-account-view="archive">
          <span class="account-hub-row-main">
            <span class="account-hub-row-title">Permanent Archive</span>
            <span class="account-hub-row-desc">Open your Tarn-backed archive link</span>
          </span>
          <span class="account-hub-chevron" aria-hidden="true">&rarr;</span>
        </button>
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
