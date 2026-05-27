import { renderAccountSubView } from './account_subview.js';
import { escapeHtml } from './book_card.js';

const SVG_CHECK = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const SVG_X = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

export function renderAccountSecurityView(content, {
  identity = {},
  onBack,
  onAfterRender,
} = {}) {
  const displayName = identity.displayName || 'User';
  renderAccountSubView(content, {
    view: 'security',
    title: 'Account & Security',
    subtitle: 'Recovery and sign-in methods for this account.',
    bodyHtml: `
      <div class="account-panel-security account-subview-section" id="accountPanelSecurity">
        <div class="account-security-block">
          <div class="account-security-subtitle">Account key</div>
          <div class="account-security-desc">A 24-word phrase that's the only way to recover your account if you forget your password.</div>
          <div class="account-security-actions">
            <button type="button" id="viewAccountKeyBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">View account key</button>
          </div>
          <button type="button" id="replaceAccountKeyBtn" class="account-security-tertiary-btn account-security-replace-link">Replace account key</button>
        </div>

        <div class="account-security-block" id="accountPasskeysBlock"></div>

        <div class="account-security-block" id="accountCredentialsBlock">
          <div class="account-security-subtitle">Username &amp; password</div>
          <div class="account-display-name-summary">
            <span>Display name</span>
            <strong id="accountDisplayNameValue">${escapeHtml(displayName)}</strong>
            <button type="button" id="changeDisplayNameBtn" class="account-security-tertiary-btn account-display-name-change">Change</button>
            <div class="account-display-name-edit" id="accountDisplayNameEdit" hidden>
              <label for="accountDisplayNameInput">Display name</label>
              <div class="account-display-name-edit-row">
                <input type="text" id="accountDisplayNameInput" maxlength="64" autocomplete="name" value="${escapeHtml(displayName)}" />
                <button type="button" id="saveDisplayNameBtn" class="account-inline-icon-btn account-inline-save-btn" aria-label="Save display name">${SVG_CHECK}</button>
                <button type="button" id="cancelDisplayNameBtn" class="account-inline-icon-btn account-inline-cancel-btn" aria-label="Cancel display name edit">${SVG_X}</button>
              </div>
            </div>
          </div>
          <div id="accountDisplayNameError" class="account-security-error" hidden></div>
          <div class="account-security-desc">Username and password let you sign in. Change either or both at any time.</div>
          <div class="account-security-actions">
            <button type="button" id="changeCredentialsBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Change username or password</button>
          </div>
        </div>
      </div>
    `,
    onBack,
    onAfterRender,
  });
}
