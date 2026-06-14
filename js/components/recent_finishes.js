// recent_finishes.js — Region A of the Friends drawer (#125).
//
// Renders the vertical list of friends' recent `finished` events as the
// primary content above the friend strip. The book COVER is the hero — a
// reading feed is about books — with the friend as a small pip on its corner:
//
//   ┌─────┬──────────────────────────────┐
//   │ COV │ Piranesi                     │   ← book title (primary)
//   │ ER◓ │ Maya finished · 2h           │   ← friend + time (secondary)
//   └─────┴──────────────────────────────┘
//
// where:
//   COVER  = ~42px-wide 2:3 cover (book.coverImage data-URL or the
//            generated-cover gradient placeholder from book_card.js).
//   ◓      = small friend-avatar PIP on the cover's corner (the #126
//            friend-pip language) — whose finish it is, at a glance.
//   text   = book title (primary) over "<friend> finished · <time>" (secondary)
//
// Tap the row → openFriendBookDetail({ book, connection }).
//
// Empty case (no events): renders nothing. The drawer's CSS hides
// `.friends-events:empty` so the drawer collapses gracefully into just the
// friend strip — which is today's reality (publish-on-save lands in #8).

import { getRecentFinishes, formatRelativeTime } from '../core/activity.js';
import { renderFriendAvatar } from './friend_avatar.js';
import { displayNameForConnection } from './friend_strip.js';
import { generatedCoverColor, escapeHtml } from './book_card.js';
import { openFriendBookDetail } from './friend_book_detail.js';
import { applyCoverCropToImage } from '../core/cover_crop.js';

const SECTION_HEADING = 'Recent finishes';

/**
 * Build the markup for one event row. Pure — returns an HTMLElement the
 * caller appends. Wires the tap handler via `onRowTap`.
 *
 * @param {{ connection: object, book: object, finished_at: number }} event
 * @param {{
 *   onRowTap: (event: object, rowEl: HTMLElement) => void,
 *   nowMs?: number,
 * }} opts
 * @returns {HTMLElement}
 */
export function buildRecentFinishRow(event, opts = {}) {
  const { connection, book, finished_at } = event;
  const name = displayNameForConnection(connection);
  const title = book.title || 'Untitled';
  const relative = formatRelativeTime(finished_at, opts.nowMs);
  const ariaLabel = `View ${title}, finished by ${name} ${relative} ago`;

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'recent-finish-row';
  row.setAttribute('aria-label', ariaLabel);
  row.dataset.sharePub = connection.share_pub || '';

  // The book cover is the hero — a reading feed is about BOOKS. It leads the
  // row, sized as a proper 2:3 with a subtle frame + shadow so it has presence.
  // Reuses the same data-URL / generated-cover pattern as book_card.js so the
  // drawer's covers look consistent with the Library.
  const coverWrap = document.createElement('div');
  coverWrap.className = 'recent-finish-cover-wrap';

  const cover = document.createElement('div');
  cover.className = 'recent-finish-cover';
  if (book.coverImage) {
    const dataUrl = `data:${book.mimeType || 'image/jpeg'};base64,${book.coverImage}`;
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '';            // decorative — full title is in the row's aria-label
    img.loading = 'lazy';
    img.dataset.fit = book.coverFit || 'contain';
    applyCoverCropToImage(img, book.coverCrop);
    cover.appendChild(img);
  } else {
    cover.classList.add('recent-finish-cover-placeholder');
    cover.style.background = generatedCoverColor(title);
    const initial = document.createElement('span');
    initial.className = 'recent-finish-cover-initial';
    initial.textContent = (title.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
    initial.setAttribute('aria-hidden', 'true');
    cover.appendChild(initial);
  }
  coverWrap.appendChild(cover);

  // Friend identity as a small avatar PIP on the cover's corner — the same
  // friend-pip visual language the Library uses (#126). Tells you whose finish
  // it is at a glance without stealing the cover's pride of place.
  const pip = renderFriendAvatar(connection, { size: 'sm', ariaLabel: name });
  pip.classList.add('recent-finish-pip');
  coverWrap.appendChild(pip);
  row.appendChild(coverWrap);

  // Text: the book TITLE leads (primary); the friend + time are quiet metadata.
  const text = document.createElement('div');
  text.className = 'recent-finish-text';
  text.innerHTML = `
    <div class="recent-finish-title">${escapeHtml(title)}</div>
    <div class="recent-finish-meta">
      <span class="recent-finish-who">${escapeHtml(name)}</span> finished<span class="recent-finish-sep" aria-hidden="true"> · </span><span class="recent-finish-time">${escapeHtml(relative)}</span>
    </div>
  `;
  row.appendChild(text);

  row.addEventListener('click', () => {
    if (typeof opts.onRowTap === 'function') opts.onRowTap(event, row);
    else openFriendBookDetail({ book, connection, returnFocusTo: row });
  });

  return row;
}

/**
 * Render the Recent finishes region into the given container.
 *
 * Replaces the container's children. When `events.length === 0` the
 * container is left EMPTY (no children). The drawer CSS rule
 * `.friends-events:empty { display: none }` hides the region in that case
 * — so callers don't need to also toggle visibility.
 *
 * @param {HTMLElement} container
 * @param {Array<{ connection: object, book: object, finished_at: number }>} events
 * @param {{
 *   onRowTap?: (event: object, rowEl: HTMLElement) => void,
 *   nowMs?: number,
 * }} [opts]
 */
export function renderRecentFinishes(container, events, opts = {}) {
  if (!container) return;
  if (!events || events.length === 0) {
    container.replaceChildren();
    return;
  }

  // Wrap in a section + heading + list. The heading is small/uppercase to
  // match `friend-strip-heading` so the two regions feel like siblings.
  const section = document.createElement('div');
  section.className = 'recent-finishes-section';

  const heading = document.createElement('div');
  heading.className = 'recent-finishes-heading';
  heading.textContent = SECTION_HEADING;
  section.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'recent-finishes-list';
  list.setAttribute('role', 'list');
  for (const ev of events) {
    const row = buildRecentFinishRow(ev, opts);
    row.setAttribute('role', 'listitem');
    list.appendChild(row);
  }
  section.appendChild(list);

  container.replaceChildren(section);
}

/**
 * One-shot helper: fetch the events from the activity layer and render them
 * into the container. Used by the drawer's open-time hydration path.
 *
 * Failures (activity throws) are swallowed with a console.warn — the region
 * stays empty, which the empty-CSS rule hides. Better than blocking the
 * drawer paint on a transient share-log error.
 *
 * @param {HTMLElement} container
 * @param {{
 *   onRowTap?: (event: object, rowEl: HTMLElement) => void,
 *   nowMs?: number,
 *   limit?: number,
 * }} [opts]
 * @returns {Promise<{ count: number }>}
 */
export async function hydrateRecentFinishes(container, opts = {}) {
  if (!container) return { count: 0 };
  let events = [];
  try {
    events = await getRecentFinishes({ limit: opts.limit });
  } catch (err) {
    console.warn('[Bookish:RecentFinishes] getRecentFinishes failed:', err.message);
    events = [];
  }
  renderRecentFinishes(container, events, opts);
  return { count: events.length };
}
