import { renderAccountSubView } from './account_subview.js';

export function renderAccountSecurityView(content, {
  onBack,
  onAfterRender,
} = {}) {
  renderAccountSubView(content, {
    view: 'security',
    title: 'Account & Security',
    subtitle: 'Manage the recovery and sign-in methods for this account.',
    bodyHtml: `
      <div class="account-panel-security account-subview-section" id="accountPanelSecurity">
        <div class="account-security-block">
          <div class="account-security-subtitle">Account key</div>
          <div class="account-security-desc">A 24-word phrase that's the only way to recover your account if you forget your password.</div>
          <div class="account-security-actions">
            <button type="button" id="viewAccountKeyBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">View account key</button>
          </div>
          <button type="button" id="replaceAccountKeyBtn" class="btn-link account-security-replace-link">Replace account key &rarr;</button>
        </div>

        <div class="account-security-block" id="accountPasskeysBlock"></div>

        <div class="account-security-block" id="accountCredentialsBlock">
          <div class="account-security-subtitle">Username &amp; password</div>
          <div class="account-security-desc">Together, these let you sign in. Change either or both at any time.</div>
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
