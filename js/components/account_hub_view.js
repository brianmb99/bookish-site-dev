import { escapeHtml } from './book_card.js';
import {
  renderSubscriptionSection,
  wireSubscriptionSection,
} from './account_subscription_section.js';

const SVG_EDIT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

export function renderAccountHeaderHtml({ email, displayName, initial }) {
  return `
    <div class="account-panel-header">
      <div class="account-avatar">${escapeHtml(initial)}</div>
      <div class="account-panel-info">
        <div class="account-panel-name">
          <span id="displayNameValue">${escapeHtml(displayName)}</span>
          <button id="editDisplayNameBtn" class="btn-link" title="Edit name">${SVG_EDIT}</button>
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
  getEmail,
  setDisplayName,
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
  wireDisplayNameEditor(content, { getEmail, setDisplayName });
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

function wireDisplayNameEditor(content, {
  getEmail,
  setDisplayName,
} = {}) {
  content.querySelector('#editDisplayNameBtn')?.addEventListener('click', () => {
    const valueEl = content.querySelector('#displayNameValue');
    const editBtn = content.querySelector('#editDisplayNameBtn');
    const current = valueEl.textContent;

    valueEl.innerHTML = `<input type="text" id="displayNameInput" value="${escapeHtml(current)}" />`;
    editBtn.innerHTML = 'Save';
    editBtn.classList.add('save-active');

    const input = content.querySelector('#displayNameInput');
    input.focus({ preventScroll: true });
    input.select();

    const save = () => {
      let newName = input.value.trim();
      if (!newName) {
        newName = (current && current.trim()) || (getEmail?.() || '').split('@')[0] || 'User';
      }
      setDisplayName?.(newName);
      valueEl.textContent = newName;
      editBtn.innerHTML = SVG_EDIT;
      editBtn.classList.remove('save-active');
      const avatar = content.querySelector('.account-avatar');
      if (avatar) avatar.textContent = (newName[0] || 'U').toUpperCase();
    };

    editBtn.onclick = save;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
  });
}
