import { renderAccountSubView } from './account_subview.js';

export const ARCHIVE_URL = 'https://arweave.net/U6dP2xK9mN3qRvT8aBc4FdEgH1jKlM2oPqRsTuVwXyZ';

export function renderArchiveView(content, {
  onBack,
  archiveUrl = ARCHIVE_URL,
  windowRef = window,
} = {}) {
  renderAccountSubView(content, {
    view: 'archive',
    title: 'Permanent Archive',
    subtitle: 'Your library export is yours regardless of subscription.',
    bodyHtml: `
      <div class="account-panel-archive account-subview-section">
        <div class="account-panel-sub-label">Your Permanent Archive</div>
        <a class="account-panel-archive-url" href="#" target="_blank" rel="noopener noreferrer" data-archive-link>arweave.net/U6dP2xK9mN3qRvT8aBc4FdEgH1jKlM2oPqRsTuVwXyZ</a>
        <div class="account-panel-archive-note">Works without Bookish. Private, permanent, and yours regardless of subscription.</div>
        <button type="button" id="accountArchiveBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Open archive <span aria-hidden="true" class="external-link-icon">\u2197</span></button>
      </div>
    `,
    onBack,
    onAfterRender: panel => wireArchiveSection(panel, { archiveUrl, windowRef }),
  });
}

export function wireArchiveSection(content, {
  archiveUrl = ARCHIVE_URL,
  windowRef = window,
} = {}) {
  const archiveLink = content.querySelector('[data-archive-link]');
  if (archiveLink) archiveLink.href = archiveUrl;
  const archiveBtn = content.querySelector('#accountArchiveBtn');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', () => {
      windowRef.open(archiveUrl, '_blank', 'noopener,noreferrer');
    });
  }
}
