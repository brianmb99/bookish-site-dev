import { renderAccountSubView } from './account_subview.js';
import { escapeHtml } from './book_card.js';

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
          </div>
          <div class="account-display-name-edit" id="accountDisplayNameEdit" hidden>
            <label for="accountDisplayNameInput">Display name</label>
            <div class="account-display-name-edit-row">
              <input type="text" id="accountDisplayNameInput" maxlength="64" autocomplete="name" value="${escapeHtml(displayName)}" />
              <button type="button" id="saveDisplayNameBtn" class="account-inline-save-btn">Save</button>
              <button type="button" id="cancelDisplayNameBtn" class="account-security-tertiary-btn account-inline-cancel-btn">Cancel</button>
            </div>
            <div id="accountDisplayNameError" class="account-security-error" hidden></div>
          </div>
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
