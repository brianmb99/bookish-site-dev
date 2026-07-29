// reading_status.js — The reading-status vocabulary, as a standalone module.
//
// These two symbols used to live in book_repository.js. They were extracted
// because they are pure vocabulary — a constant map and a total function over
// it — with zero dependencies, while book_repository.js pulls in the entire
// sync/persistence/sharing stack (friends → Tarn service → SDK).
//
// The forcing case is the standalone recovery page (`tools/forever/`), which
// renders recovered books using the app's REAL card builder
// (`components/book_card.js`) so the recovered shelf looks exactly like the
// Library. book_card.js needs only READING_STATUS + normalizeReadingStatus;
// importing them from book_repository.js would have dragged the whole
// networked app into a page whose entire purpose is to work with no servers
// at all.
//
// book_repository.js re-exports both symbols, so every existing
// `import { READING_STATUS } from './book_repository.js'` keeps working —
// this extraction is additive, not a migration.

/** The three shelves a book can live on. Values are the persisted wire
 *  strings (see bookish_schema.js `readingStatus` enum) — do not rename. */
export const READING_STATUS = {
  WANT_TO_READ: 'want_to_read',
  READING: 'reading',
  READ: 'read',
};

/**
 * Total function: map an entry to one of the three statuses.
 *
 * Anything unrecognized (absent, legacy, malformed) resolves to READ — the
 * historical default, since Bookish began as a read-log and pre-status
 * entries are all finished books.
 *
 * @param {{readingStatus?: string}|null|undefined} entry
 * @returns {string} one of READING_STATUS's values
 */
export function normalizeReadingStatus(entry) {
  const s = entry?.readingStatus;
  if (s === READING_STATUS.WANT_TO_READ || s === READING_STATUS.READING || s === READING_STATUS.READ) return s;
  return READING_STATUS.READ;
}
