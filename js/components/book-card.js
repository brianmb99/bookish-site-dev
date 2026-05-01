// book-card.js — Shared book-card builders.
//
// These functions used to live as private helpers inside app.js. Issue #123
// (friend's-shelf full-screen view) needs to render another user's books
// using the *exact same* card markup as the user's own Library — extracting
// the builders here lets both surfaces consume one source of truth instead
// of forking the markup.
//
// What's here:
//   - generatedCoverColor(title)  — deterministic gradient for cover-less books
//   - buildCardDetails(entry, shelfContext)  — inline meta row
//   - buildCardHTML(entry, isWtrResult)  — full inner HTML for one card
//   - escapeHtml(s)
//
// What stays in app.js:
//   - The render() loop, keyed reconciliation, exit animations, card-level
//     event wiring (openModalWithHero), skeleton rendering. Those carry
//     state that's specific to the user's own Library and don't generalize.
//
// The shared builders are intentionally pure: take an entry, return an
// HTML string. Read-only friend's-shelf cards use the same markup. The
// difference between editable (own library) and read-only (friend's shelf)
// is enforced by *not wiring up* the click → detail-modal handlers on the
// friend's-shelf side, not by branching the markup. That keeps "looks
// identical to my own shelf" trivially true.
//
// `◐` currently-reading accent: the visual treatment is in CSS, keyed off
// `.card[data-reading="true"]`. The dataset attribute is set by the *caller*
// (app.js render loop or friend-shelf-view), not by the builders here, so
// the friend's-shelf inherits the accent automatically without us re-stating
// the rule.

import { formatMonthYearDisplay } from '../core/id_core.js';
import { READING_STATUS, normalizeReadingStatus } from '../core/book_repository.js';

// --- Generated cover color palette (kept in lockstep with the historical
// app.js list — these palette colors are part of the design system and
// shouldn't drift between Library and friend's-shelf). ---
const COVER_PALETTE = [
  'linear-gradient(145deg,#6b2137 0%,#4a1528 100%)', // burgundy
  'linear-gradient(145deg,#1e3a5f 0%,#152a45 100%)', // navy
  'linear-gradient(145deg,#2d4a3e 0%,#1c332b 100%)', // forest
  'linear-gradient(145deg,#5b4a3f 0%,#3d312a 100%)', // umber
  'linear-gradient(145deg,#4a3b6b 0%,#332852 100%)', // plum
  'linear-gradient(145deg,#3a5043 0%,#263830 100%)', // sage
  'linear-gradient(145deg,#5a3e3e 0%,#3d2929 100%)', // clay
  'linear-gradient(145deg,#2a4a5a 0%,#1c3340 100%)', // slate
  'linear-gradient(145deg,#5a4a2a 0%,#3d3220 100%)', // olive
  'linear-gradient(145deg,#4a2a4a 0%,#331e33 100%)', // aubergine
];

export function generatedCoverColor(title) {
  const t = String(title || '');
  let h = 0;
  for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
  return COVER_PALETTE[Math.abs(h) % COVER_PALETTE.length];
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the slim details row for a card. Single horizontal line:
 *   `date · [status if reading + optional mark-as-read button] · [rating if set]`
 *
 * Date label by shelf:
 *   - reading: plain "<Mon YYYY>" from readingStartedAt (fallback createdAt).
 *   - read:    plain "<Mon YYYY>" from dateRead
 *   - wtr:     "Added <Mon YYYY>" from createdAt
 *
 * @param {Object} opts
 * @param {boolean} [opts.showActions] - if true and the card is on the
 *   currently-reading shelf, render a small ✓ button after the "Reading"
 *   label that the caller can wire to a mark-as-read action. Default false
 *   (read-only callers like friend-shelf-view get no button).
 */
export function buildCardDetails(e, shelfContext, opts = {}) {
  const { showActions = false } = opts;
  const parts = [];
  let dateText = '';
  if (shelfContext === 'reading') {
    dateText = formatMonthYearDisplay(e.readingStartedAt || e.createdAt);
  } else if (shelfContext === 'wtr') {
    const d = formatMonthYearDisplay(e.createdAt);
    if (d) dateText = `Added ${d}`;
  } else {
    // 'read' (default)
    dateText = formatMonthYearDisplay(e.dateRead);
  }
  if (dateText) parts.push(`<span class="card-date">${escapeHtml(dateText)}</span>`);
  if (shelfContext === 'reading') {
    const cardKey = e.txid || e.id || '';
    // Use a span with role="button" instead of <button> — native button
    // rendering on Samsung Internet / Chrome was leaving a visible 1px
    // edge on the right of the invisible click box even after aggressive
    // CSS resets. A span has zero native chrome to fight.
    const markBtn = (showActions && cardKey)
      ? `<span role="button" tabindex="0" class="card-mark-read" data-mark-read-key="${escapeHtml(cardKey)}" title="Mark as read" aria-label="Mark as read">✓</span>`
      : '';
    parts.push(`<span class="card-reading-status" aria-label="Currently reading">Reading${markBtn}</span>`);
  }
  if (e.rating && e.rating >= 1 && e.rating <= 5) {
    const stars = '★'.repeat(e.rating);
    parts.push(`<span class="card-rating" aria-label="Rated ${e.rating} out of 5">${stars}</span>`);
  }
  if (!parts.length) return '';
  return `<div class="details">${parts.join('<span class="card-meta-sep" aria-hidden="true"> · </span>')}</div>`;
}

/**
 * Build inner HTML for a single book card. Returns the cover + meta block —
 * the surrounding `<div class="card" data-...>` wrapper is the caller's
 * responsibility (it carries dataset attributes that reflect render-loop
 * state, e.g. `data-reading`, `data-fmt`, `data-txid`).
 *
 * @param {Object} e - book entry
 * @param {boolean} [isWtrResult] - true if this card is rendering a
 *   want-to-read result (omnibox; affects shelfContext)
 */
export function buildCardHTML(e, isWtrResult, opts = {}) {
  const coverDataUrl = e.coverImage ? `data:${e.mimeType || 'image/jpeg'};base64,${e.coverImage}` : '';
  const rs = normalizeReadingStatus(e);
  const isReading = rs === READING_STATUS.READING;
  let shelfContext = 'read';
  if (isWtrResult || rs === READING_STATUS.WANT_TO_READ) {
    shelfContext = 'wtr';
  } else if (isReading) {
    shelfContext = 'reading';
  }
  const detailsRow = buildCardDetails(e, shelfContext, opts);
  const titleSafe = escapeHtml(e.title || 'Untitled');
  const authorSafe = escapeHtml(e.author || '');
  const overlay = `<div class="cover-hover" aria-hidden="true"><div class="cover-hover-title">${titleSafe}</div>${authorSafe ? `<div class="cover-hover-author">${authorSafe}</div>` : ''}</div>`;
  const srLabel = `<span class="sr-only">${titleSafe}${authorSafe ? ` by ${authorSafe}` : ''}</span>`;
  // The cover lives inside a `.cover-wrap` so absolutely-positioned siblings
  // can straddle the cover's edge without being clipped by the cover's own
  // `overflow: hidden` (used to clip the rounded image + the blur-fill bg).
  // Today the only such sibling is the friend-pip overlay (#126), attached
  // post-render by the Library render loop. Keeping the wrapper here means
  // the pip overlay has a stable, layout-aware anchor — the wrap sits in
  // the same flex slot the cover used to occupy on its own, so card layouts
  // (row on desktop, column on mobile) don't need to know about pips.
  return `
      <div class="cover-wrap">
        <div class="cover"${coverDataUrl ? ` style="--cover-url:url('${coverDataUrl}')"` : ''}>${e.coverImage ? `<img src="${coverDataUrl}" data-fit="${e.coverFit || 'contain'}">` : `<div class="generated-cover" style="background:${generatedCoverColor(e.title || '')}"><span class="generated-title">${escapeHtml(e.title || 'Untitled')}</span>${e.author ? `<span class="generated-author">${escapeHtml(e.author)}</span>` : ''}</div>`}${overlay}</div>
      </div>
      <div class="meta">
        ${srLabel}
        ${detailsRow}
      </div>`;
}
