// omnibox_merge.js - Pure logic for omnibox add-book result mapping & dedup.
//
// Extracted from app.js:searchOmniboxApis as pure code motion (no behavior
// change). This module exists so the same merge logic the browser uses can
// also be called from Node (search-quality research script). Anything that
// touches the DOM, fetch, AbortController, or app state stays in app.js.
//
// Known smells preserved verbatim (do NOT fix here — fix in follow-ups after
// the research pass quantifies impact):
//   - stripNoise is applied asymmetrically: iTunes titles are stripped at
//     mapping time, OL titles are stripped only inside mergeOmniboxResults.
//   - omniboxDedupeKey uses a looser key than search_core.displayKeyBook.

import { stripNoise } from './search_core.js';

/**
 * Map a raw Open Library search-hit doc to the normalized omnibox entry shape.
 * NOTE: title is NOT pre-stripped here — that happens inside mergeOmniboxResults
 * (when computing the dedupe key and the surviving entry's display title).
 * Preserving this asymmetry is intentional.
 */
export function normalizeOLDoc(doc) {
  const d = doc || {};
  return {
    title: d.title || '',
    author: d.author_name?.[0] || '',
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
    publisher: '',
    duration: '',
    source: 'ol',
    work_key: d.key || '',
    isbn: (d.isbn || [])[0] || ''
  };
}

/**
 * Map a raw iTunes search-hit item to the normalized omnibox entry shape.
 * iTunes titles ARE pre-stripped of noise here (Unabridged markers, trailing
 * years) — this is the asymmetry called out above.
 */
export function normalizeItunesItem(item) {
  const i = item || {};
  return {
    title: stripNoise(i.collectionName || i.trackName || ''),
    author: i.artistName || '',
    year: '',
    coverUrl: i.artworkUrl100 || '',
    publisher: '',
    duration: '',
    source: 'itunes',
    artwork: i.artworkUrl100 || ''
  };
}

/**
 * Compute the dedup key for a normalized omnibox entry.
 * Key = stripNoise(title).lower.alphanum + '|' + author.lower.alphanum.
 *
 * Note: this is intentionally looser than search_core.displayKeyBook
 * (which normalizes author initials). Don't swap them — that's a deferred fix.
 */
export function omniboxDedupeKey(entry) {
  const e = entry || {};
  const cleanTitle = stripNoise(e.title || '');
  const titlePart = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
  const authorPart = (e.author || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return titlePart + '|' + authorPart;
}

/**
 * Merge iTunes and OL normalized result arrays into a deduped entry list.
 *
 * Iteration order is [...itunesResults, ...olResults] (iTunes first); the
 * first entry seen for a given dedup key wins, so an iTunes hit suppresses
 * a matching OL hit. When a later duplicate carries a work_key or isbn the
 * survivor lacks, those values transfer to the survivor. The survivor's
 * display `title` is set to stripNoise(rawTitle) (idempotent on the iTunes
 * side, but visible on the OL side).
 *
 * Pure: no DOM, no fetch, no app state.
 */
export function mergeOmniboxResults({ itunesResults = [], olResults = [] } = {}) {
  const combined = [];
  const seen = new Map();
  for (const r of [...itunesResults, ...olResults]) {
    const cleanTitle = stripNoise(r.title || '');
    const k = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '') + '|' +
              (r.author || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(k)) {
      const existing = seen.get(k);
      if (r.work_key && !existing.work_key) existing.work_key = r.work_key;
      if (r.isbn && !existing.isbn) existing.isbn = r.isbn;
      continue;
    }
    const entry = { ...r, title: cleanTitle };
    seen.set(k, entry);
    combined.push(entry);
  }
  return combined;
}
