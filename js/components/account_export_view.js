import { renderAccountSubView } from './account_subview.js';

const SVG_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

export function renderExportView(content, {
  onBack,
  onExportCsv,
} = {}) {
  renderAccountSubView(content, {
    view: 'export',
    title: 'Data Export',
    subtitle: 'Download a simple CSV copy of your reading list.',
    bodyHtml: `
      <div class="account-data-export account-subview-section">
        <div class="account-security-subtitle">CSV export</div>
        <div class="account-security-desc">Includes title, author, date read, rating, format, and notes for every active book on this device.</div>
        <div class="account-security-actions">
          <button id="exportCsvBtn" class="btn secondary account-csv-btn">
            ${SVG_DOWNLOAD} Export CSV
          </button>
        </div>
      </div>
    `,
    onBack,
    onAfterRender: panel => {
      panel.querySelector('#exportCsvBtn')?.addEventListener('click', () => onExportCsv?.());
    },
  });
}
