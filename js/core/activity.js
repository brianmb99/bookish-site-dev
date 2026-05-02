// activity.js — Derives "Recent finishes" events from connections' share-log
// data (issue #125 / Surface 1 Region A in FRIENDS.md).
//
// What this module produces:
//
//   getRecentFinishes({ limit }) →
//     Array<{
//       connection,    // the friend (label, share_pub, signing_pub, …)
//       book,          // the friend's book record (title, author, dateRead, …)
//       finished_at,   // ms-epoch — equal to book.dateRead
//     }>
//
// Sorted reverse-chronologically (newest first), capped at `limit` (default 10),
// muted-friend events filtered out per FRIENDS.md ("uses isMuted(connection)").
//
// ── Why snapshot-based, not per-operation ────────────────────────────────────
//
// FRIENDS.md / 05-recent-finishes.md left the choice open: derive events from
// discrete share-log entries (each transition has its own timestamp), or diff
// snapshots (synthesize events from state changes). Tarn's actual surface forces
// our hand: `readShareLog` exposes only the final state map
// `{content_id: {tx_id, cek}}`. Per-operation timestamps are consumed inside
// `applyOperationToState` and discarded; there is no public method to enumerate
// operations.
//
// We use the snapshot approach but lean on a property of Bookish's data shape
// that makes synthesis unnecessary: every Bookish book record carries its own
// `dateRead` field — the user-meaningful "when did I finish this?" timestamp
// that the user actually entered. So we don't need to detect a transition; we
// can simply read the snapshot, filter to records where
// `readingStatus === 'read'` && `dateRead` is set, and use `dateRead` as the
// `finished_at`.
//
// Consequences of this choice (honest about them):
//   - If a friend marks Read → Reading → Read again, only the latest dateRead
//     surfaces. There is no per-transition history. This matches user intent
//     ("when did Maya finish this book?") far better than "when did the
//     publish-event hit Arweave."
//   - The derivation works without any Tarn protocol changes.
//   - The same code lights up automatically the moment publish-on-save lands
//     in issue #8 — no further changes needed here.
//
// ── Pre-known constraint (publish-on-save gap) ───────────────────────────────
//
// Today, Bookish doesn't publish books to the share log (issue #8 — per-book
// privacy — gates the publish path). Until #8 ships, every friend's
// `fetchFriendLibrary` returns []. This module returns [] in that case and the
// `recent-finishes.js` component renders nothing (the region is hidden).

import * as friends from './friends.js';
import * as tarnService from './tarn_service.js';
import { READING_STATUS, normalizeReadingStatus } from './book_repository.js';

const DEFAULT_LIMIT = 10;

// activity.js consumes the friends.* facade for the data path. Mute
// resolution goes through `friends.isMuted()` which fail-opens on errors.

/**
 * Get the user's friends' recent `finished` events, ready to render.
 *
 * Reads each non-muted connection's share-log snapshot via
 * {@link friends.fetchFriendLibrary}, filters to Read books with a `dateRead`,
 * sorts reverse-chronologically, and caps at `limit`.
 *
 * The function is defensive about partial failure: a single friend whose
 * share-log fetch throws is skipped (warning logged). The remainder still
 * surface their events.
 *
 * @param {{ limit?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Array<{ connection: object, book: object, finished_at: number }>>}
 */
export async function getRecentFinishes(opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;

  if (!tarnService.isLoggedIn()) return [];

  let connections = [];
  try {
    connections = await friends.listConnections();
  } catch (err) {
    console.warn('[Bookish:Activity] listConnections failed:', err.message);
    return [];
  }
  if (!connections || connections.length === 0) return [];

  // Filter out muted connections up front so we don't waste fetches on them.
  // friends.isMuted() fail-opens on transient errors — the failure mode of
  // "we showed events from a muted friend on a transient client error" is
  // much gentler than "we hid every event."
  const visible = [];
  for (const conn of connections) {
    if (!conn || !conn.share_pub) continue;
    // tarn.connections.list() returns conn.muted directly now; trust it
    // when present, fall back to the per-conn check otherwise.
    if (conn.muted === true) continue;
    if (conn.muted === undefined) {
      let muted = false;
      try { muted = await friends.isMuted(conn); } catch { muted = false; }
      if (muted) continue;
    }
    visible.push(conn);
  }
  if (visible.length === 0) return [];

  // Fetch each friend's library in parallel. allSettled so one failing
  // fetch doesn't kill the whole surface — the other friends still
  // contribute events. fetchImpl injection is no longer needed: the new
  // SDK owns the gateway fetch + decrypt path, so tests stub the SDK
  // directly via vi.doMock(...).
  const results = await Promise.allSettled(
    visible.map(conn => friends.fetchFriendLibrary(conn)),
  );

  const events = [];
  results.forEach((r, idx) => {
    if (r.status !== 'fulfilled') {
      console.warn(
        '[Bookish:Activity] fetchFriendLibrary failed for',
        visible[idx].share_pub?.slice(0, 8),
        r.reason?.message,
      );
      return;
    }
    const conn = visible[idx];
    const library = r.value || [];
    for (const book of library) {
      const finishedAt = extractFinishedAt(book);
      if (finishedAt == null) continue;
      events.push({ connection: conn, book, finished_at: finishedAt });
    }
  });

  // Reverse-chronological, then cap. Stable secondary sort on share_pub +
  // book identifier so two events with identical timestamps stay in a
  // deterministic order (mostly matters in tests).
  events.sort((a, b) => {
    if (b.finished_at !== a.finished_at) return b.finished_at - a.finished_at;
    const cmpPub = (a.connection.share_pub || '').localeCompare(b.connection.share_pub || '');
    if (cmpPub !== 0) return cmpPub;
    return (bookKey(a.book)).localeCompare(bookKey(b.book));
  });

  return events.slice(0, limit);
}

/**
 * Pull the `finished_at` timestamp from a friend's book record.
 *
 * Returns ms-epoch if the record represents a finished book, null otherwise.
 *
 * Rules:
 *   - readingStatus must normalize to READ (the snapshot may carry an absent
 *     readingStatus on legacy entries; normalizeReadingStatus defaults those
 *     to READ — that's intentional in our code, and matches how the user's
 *     own Library treats them).
 *   - dateRead must be a finite, positive number (ms-epoch). A book marked
 *     Read with no dateRead is not surfaced — we have no time to attach.
 *
 * @param {object} book
 * @returns {number | null}
 */
export function extractFinishedAt(book) {
  if (!book || typeof book !== 'object') return null;
  if (normalizeReadingStatus(book) !== READING_STATUS.READ) return null;
  const t = book.dateRead;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return null;
  return t;
}

/**
 * Stable identity for a book inside the secondary-sort tiebreaker. Prefers
 * work_key (the friend-matching primitive from #111) and falls back through
 * isbn13 → bookId → title+author. The exact field doesn't matter for
 * correctness — only that two distinct books always disagree.
 */
function bookKey(book) {
  return book.work_key
    || book.isbn13
    || book.bookId
    || `${book.title || ''}|${book.author || ''}`;
}

/**
 * Format a ms-epoch timestamp as a compact relative string for the row's
 * second line.
 *
 *   < 1m → "now"
 *   <1h  → "{N}m"
 *   <24h → "{N}h"
 *   <7d  → "{N}d"
 *   <4w  → "{N}w"
 *   <12mo→ "{N}mo"
 *   else → "{N}y"
 *
 * Negative deltas (future timestamps from clock skew) clamp to "now". This
 * matches the "Maya finished Piranesi · 2h" treatment in FRIENDS.md without
 * needing a localization library — the surface is intentionally narrow and
 * fits the tone of compact event rows.
 *
 * @param {number} timestampMs
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatRelativeTime(timestampMs, nowMs = Date.now()) {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return '';
  const diff = Math.max(0, nowMs - timestampMs);
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;       // calendar-agnostic — close enough for this surface
  const YEAR = 365 * DAY;

  if (diff < MIN) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d`;
  if (diff < 4 * WEEK) return `${Math.floor(diff / WEEK)}w`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}mo`;
  return `${Math.floor(diff / YEAR)}y`;
}
