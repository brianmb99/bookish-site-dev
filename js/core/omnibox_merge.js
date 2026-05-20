// omnibox_merge.js - Pure logic for omnibox add-book result mapping & dedup.
//
// Extracted from app.js:searchOmniboxApis as pure code motion (no behavior
// change). This module exists so the same merge logic the browser uses can
// also be called from Node (search-quality research script). Anything that
// touches the DOM, fetch, AbortController, or app state stays in app.js.
//
// Title cleanup is intentionally aggressive. Two passes (in order):
//   1. stripAllBracketed — drop every (...) and [...] segment. Catches
//      marketing copy ("(National Book Award Finalist)"), audiobook markers
//      ("(Unabridged)", "[1/2]"), edition info ("(Spanish Edition)"), and
//      series tags ("(Lord of the Rings)", "(Empyrean)").
//   2. stripMarketingSubtitles — drop a curated stoplist of colon-prefixed
//      marketing tails ("...: A Novel", "...: A Memoir", "...: A GMA Book
//      Club Pick", etc.), iteratively until stable. Descriptive subtitles
//      (real information about the book) are intentionally preserved.
// Both passes are applied to the dedupe key AND the displayed title.
//
// Author side: dedupe key uses normalizeAuthorKey(stripCredentials(author))
// — sorted initials + surname, lowercase, with common credentials
// ("M.D.", "Ph.D.", "Jr.", etc.) stripped first. Catches Bessel van der
// Kolk vs Bessel van der Kolk, M.D. and similar variant-spelling cases.
//
// The Phase 2 search-quality audit (5,032-query corpus, tools/audit-search)
// established the pattern inventories and confirmed the impact: #201
// changed 53.5% of queries, #202 a further 6%, #203 a tail of 2.7%.
// Cost is the rare informative paren (e.g. "(Annotated)") — accepted as
// the price of collapsing the duplicate-row noise that dominates the long
// tail.
//
// stripNoise from search_core is no longer used in the merge body (the
// aggressive bracket strip subsumes it). It is still applied at iTunes
// mapping time inside normalizeItunesItem — that asymmetry predates the
// audit-driven cleanup and is intentionally preserved.

import { stripNoise, normalizeAuthorKey } from './search_core.js';

// Aggressive title cleaner: strip every () and [] segment, collapse
// whitespace, then trim. Used for both the dedupe key and the display title.
export function stripAllBracketed(title) {
  return (title || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Marketing-subtitle stoplist. Patterns observed in the suffix inventory
// (see tools/audit-search/results/decisions.md). Matches a colon-prefixed
// segment exactly (case-insensitive), bounded by another colon/bracket-opener
// or end-of-string. Descriptive subtitles like "Born a Crime: Stories from
// a South African Childhood" are preserved because the bare `Stories` only
// fires at a segment boundary.
export const MARKETING_SUFFIX_RE = new RegExp(
  '\\s*:\\s*(' + [
    'A Novel', 'A novel', 'a novel',
    'A Memoir', 'A memoir',
    'A Story', 'A True Story', 'A Love Story',
    'A GMA Book Club Pick',
    "A Reese's Book Club Pick", "Reese's Book Club Pick",
    "Oprah's Book Club",
    'National Bestseller', 'National Book Award (?:Finalist|Winner)',
    'Stories', 'Essays',
  ].join('|') + ')(\\s*[:(\\[]|\\s*$)',
  'gi'
);

// Strip marketing subtitles iteratively (they can stack, e.g.
// "Klara and the Sun: A GMA Book Club Pick: A novel"). Loop until stable.
export function stripMarketingSubtitles(title) {
  let prev = null, cur = (title || '').trim();
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(MARKETING_SUFFIX_RE, (_, _seg, tail) => tail || '').trim();
  }
  return cur;
}

// Common author credentials/honorifics to strip before author normalization.
// Catches "Bessel van der Kolk, M.D." vs "Bessel van der Kolk" and similar.
export function stripCredentials(author) {
  return (author || '')
    .replace(/,?\s*(M\.?\s*D\.?|Ph\.?\s*D\.?|MD|PhD|Esq\.?|Jr\.?|Sr\.?|III|II|IV|MBA|MSW|RN|MS|MA|BA)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}

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
 * Key = stripMarketingSubtitles(stripAllBracketed(title)).lower.alphanum
 *       + '|' + normalizeAuthorKey(stripCredentials(author)).
 */
export function omniboxDedupeKey(entry) {
  const e = entry || {};
  const cleanTitle = stripMarketingSubtitles(stripAllBracketed(e.title || ''));
  const titlePart = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
  const authorPart = normalizeAuthorKey(stripCredentials(e.author || ''));
  return titlePart + '|' + authorPart;
}

/**
 * Merge iTunes and OL normalized result arrays into a deduped entry list.
 *
 * Iteration order is [...itunesResults, ...olResults] (iTunes first); the
 * first entry seen for a given dedup key wins, so an iTunes hit suppresses
 * a matching OL hit. When a later duplicate carries a work_key or isbn the
 * survivor lacks, those values transfer to the survivor. The survivor's
 * display `title` is set to stripMarketingSubtitles(stripAllBracketed(rawTitle)).
 *
 * Pure: no DOM, no fetch, no app state.
 */
export function mergeOmniboxResults({ itunesResults = [], olResults = [] } = {}) {
  const combined = [];
  const seen = new Map();
  for (const r of [...itunesResults, ...olResults]) {
    const cleanTitle = stripMarketingSubtitles(stripAllBracketed(r.title || ''));
    const k = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '') + '|' +
              normalizeAuthorKey(stripCredentials(r.author || ''));
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
