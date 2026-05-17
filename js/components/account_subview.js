import { escapeHtml } from './book-card.js';

export function renderAccountSubView(content, {
  view,
  title,
  subtitle,
  bodyHtml,
  onBack,
  onAfterRender,
} = {}) {
  content.innerHTML = `
    <div class="auth-form account-subview" data-account-view="${escapeHtml(view)}">
      <button type="button" class="account-subview-back" id="accountBackBtn">&larr; Account</button>
      <div class="account-subview-heading">
        <h2>${escapeHtml(title)}</h2>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${bodyHtml}
    </div>
  `;

  content.querySelector('#accountBackBtn')?.addEventListener('click', () => onBack?.());
  onAfterRender?.(content);
}
