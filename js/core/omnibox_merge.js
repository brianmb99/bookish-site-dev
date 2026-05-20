// omnibox_merge.js - Pure logic for omnibox add-book result mapping & dedup.
//
// Extracted from app.js:searchOmniboxApis as pure code motion (no behavior
// change). This module exists so the same merge logic the browser uses can
// also be called from Node (search-quality research script). Anything that
// touches the DOM, fetch, AbortController, or app state stays in app.js.
//
// Title cleanup is intentionally aggressive. Three passes (composed in this
// order — stripFormatSuffix first so dash-format markers come off before
// bracket-stripping changes the shape):
//   1. stripFormatSuffix — drop trailing " - <FormatMarker>" segments
//      ("Dead Souls - Audiobook" → "Dead Souls"). Pattern list is
//      conservative (Audiobook, Audio Edition, Audio, Unabridged, Abridged,
//      Dramatized, Dramatized Adaptation, plus a couple multilingual
//      variants seen in the audit corpus). Case-insensitive, iterative.
//   2. stripAllBracketed — drop every (...) and [...] segment. Catches
//      marketing copy ("(National Book Award Finalist)"), audiobook markers
//      ("(Unabridged)", "[1/2]"), edition info ("(Spanish Edition)"), and
//      series tags ("(Lord of the Rings)", "(Empyrean)").
//   3. stripMarketingSubtitles — drop a curated stoplist of colon-prefixed
//      marketing tails ("...: A Novel", "...: A Memoir", "...: A GMA Book
//      Club Pick", etc.), iteratively until stable. Descriptive subtitles
//      (real information about the book) are intentionally preserved.
// All three passes are applied to the dedupe key AND the displayed title.
//
// Author side: dedupe key uses
//   normalizeAuthorKey(stripCredentials(firstAuthorOnly(author)))
// — first author only (multi-author iTunes strings often include narrators
// and audiobook publishers), credentials stripped, then sorted initials +
// surname lowercased. Catches Bessel van der Kolk vs Bessel van der
// Kolk, M.D.; also collapses "Nikolai Gogol, Classic Audiobooks & Hörbuch
// Klassiker" → "Nikolai Gogol" so the audiobook variant shares a key with
// the canonical OL row. firstAuthorOnly is applied for the KEY only — the
// displayed author string remains the full original.
//
// The Phase 2 search-quality audit (5,032-query corpus, tools/audit-search)
// established the pattern inventories and confirmed the impact: #201
// changed 53.5% of queries, #202 a further 6%, #203 a tail of 2.7%.
// #204 is a follow-up tail-case fix (dash-prefixed format markers + first-
// author dedupe key) surfaced by validating the prior fixes on `dead souls`.
// #205 adds a SECONDARY dedup pass after the primary key match: pairs that
// share title-key AND first-initial+surname collapse, catching middle-name
// expansions like "Nikolai Gogol" vs "Nikolai Vasilievich Gogol". Cache-
// replay validation showed 3.4% of corpus queries affected, all observed
// collapses were legitimate same-author variants.
// #206 drops OL entries whose language array contains only non-English
// values, catching foreign-script editions like "Мертвые души" (Cyrillic
// Dead Souls) that survive dedup because their author keys are character-
// disjoint from Latin spellings. Requires `language` in the OL search
// fields= param (set in omnibox_controller.js). iTunes entries always pass.
// #212 filters non-English iTunes (and OL fallback) titles by stopword
// heuristic — catches Spanish "Klara y el sol", Italian "Klara e il sole",
// German "K für Klara", and non-Latin scripts. Only applies when the query
// itself looks English.
// #208 adds a tertiary suffix-collapse pass: for pairs sharing author-key
// where one title is a strict suffix of the other (≥10 chars), collapse
// them — catches series-prefix variants ("The Lord of the Rings: The
// Fellowship of the Ring" → "The Fellowship of the Ring") and omnibuses
// ("Animal Farm / Nineteen Eighty-Four" → "Nineteen Eighty-Four"). Branches
// on prefix shape: article prefixes ("A ", "The ") keep the LONGER
// (canonical with article); any other prefix drops the longer.
// #210 adds a score-based rerank as the final pipeline stage when a query
// is passed. Exact-title matches bubble above iTunes's native order
// (catches "iTunes returned the marketing-subtitle variant at top"
// patterns the dedup passes can't fix). Quality filter prevents low-data
// OL entries from leapfrogging into top-5 just because their bare title
// happens to be string-equal to the query — they can still appear in
// the dropdown but not above visible canonical results.
// Cost is the rare informative paren (e.g. "(Annotated)") — accepted as
// the price of collapsing the duplicate-row noise that dominates the long
// tail.
//
// stripNoise from search_core is no longer used in the merge body (the
// aggressive bracket strip subsumes it). It is still applied at iTunes
// mapping time inside normalizeItunesItem — that asymmetry predates the
// audit-driven cleanup and is intentionally preserved.

import { stripNoise, normalizeAuthorKey, isEnglish, scoreDocument, tokenize } from './search_core.js';

// Dash-prefixed format-marker stoplist. iTunes regularly returns titles
// of the form "Dead Souls - Audiobook" (the format marker appears after a
// dash rather than inside parens). Pattern list mirrors the obvious set
// from the audit-search cache; cross-corpus inventory (677/41,991 titles)
// confirmed `Audiobook` dominates with a long thin tail. Multilingual
// variants ("Livre Audio", "Dramatizado") are included because they're
// unambiguous format markers that can't plausibly be real subtitles.
// Stays conservative — anything that could be a legitimate subtitle is
// excluded.
export const FORMAT_SUFFIX_RE = new RegExp(
  '\\s+-\\s+(' + [
    'Dramatized Adaptation',
    'Audio Edition',
    'Audiobook',
    'Audio',
    'Unabridged',
    'Abridged',
    'Dramatized',
    'Dramatizado',
    'Livre Audio',
  ].join('|') + ')\\s*$',
  'i'
);

// Iteratively strip trailing dash-prefixed format markers. Loops until
// stable so compound suffixes ("Title - Unabridged - Audiobook", however
// unlikely) collapse to the bare title.
export function stripFormatSuffix(title) {
  let prev = null, cur = (title || '').trim();
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(FORMAT_SUFFIX_RE, '').trim();
  }
  return cur;
}

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

// Title-language heuristic for #212. iTunes doesn't expose a language field
// in its search response, so foreign-language audiobook editions slip past
// the OL-only filter from #206. We detect them by stopword frequency: a
// title is "likely foreign" if it contains 2+ non-English stopwords AND
// zero English stopwords, OR contains non-Latin-script characters
// (Cyrillic / Greek / Arabic / CJK / Hebrew). The filter only applies when
// the query itself looks English — a user who actually types a Spanish or
// Italian title should still get Spanish/Italian results.

// English stopwords likely to appear in real titles.
const _ENGLISH_STOPWORDS = new Set([
  'the','of','and','an','in','on','to','for','with','at','from','is','by','but','or'
]);

// Stopwords from the major translation languages observed in iTunes results
// (Spanish, Italian, German, French). Deduped where languages overlap.
const _FOREIGN_STOPWORDS = new Set([
  // Spanish
  'y','el','la','los','las','de','del','un','una','con','sus','sobre',
  // Italian (extras beyond what's already in Spanish)
  'e','il','lo','gli','della','sul','di','che','sull','sulla','col','che',
  // German
  'der','die','das','und','mit','für','von','zu','ist','ungekürzt','folge','ungek',
  // French (extras beyond what's already covered)
  'le','du','et','dans','sur','ou'
]);

// Unicode ranges for non-Latin scripts we want to flag as foreign:
// Cyrillic (0400-04FF), Cyrillic Supplement (0500-052F), Greek (0370-03FF),
// Arabic (0600-06FF), Syriac (0700-074F), Hebrew (0590-05FF), Hiragana
// (3040-309F), Katakana (30A0-30FF), CJK ext A (3400-4DBF), CJK Unified
// (4E00-9FFF), Hangul (AC00-D7AF).
const _NON_LATIN_RE = /[Ѐ-ԯͰ-Ͽ֐-ۿ܀-ݏ぀-ヿ㐀-鿿가-힯]/;

export function isLikelyForeign(text) {
  if (!text) return false;
  if (_NON_LATIN_RE.test(text)) return true;
  const tokens = text.toLowerCase()
    .replace(/[^a-zà-ÿ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let en = 0, fr = 0;
  for (const t of tokens) {
    if (_ENGLISH_STOPWORDS.has(t)) en++;
    else if (_FOREIGN_STOPWORDS.has(t)) fr++;
  }
  return fr >= 2 && en === 0;
}

// Quality gate for the post-merge rerank (#210). iTunes entries always pass.
// OL entries fail when the data is sparse enough that letting them rank into
// the visible top-of-dropdown would surface noise: empty/whitespace author,
// missing work_key, or "author" string that looks like a publisher / summary
// outfit rather than a real author. Used to enforce a hard top-5 cap so the
// rerank can bubble canonical exact-title matches without also boosting
// sketchy OL editions just because they happen to be string-equal to the query.
export function isHighQualityForRerank(entry) {
  if (!entry || entry.source !== 'ol') return true;
  if (!entry.author || !entry.author.trim()) return false;
  if (!entry.work_key) return false;
  const a = entry.author.toLowerCase();
  if (a.includes('summaries') || a.includes('summary')
      || a.includes('study guide') || a.includes('bright bright')) return false;
  return true;
}

// First-initial + surname key for the SECONDARY dedupe pass. Looser than the
// primary author key (which uses normalizeAuthorKey's sorted-initials) so
// middle-name variants like "Nikolai Gogol" vs "Nikolai Vasilievich Gogol"
// produce the SAME key here (both → "ngogol"). Only safe to use in the
// secondary pass because it requires title-key match too; without that
// constraint we'd over-collapse distinct authors like "George R. R. Martin"
// vs "George Martin".
export function firstInitialKey(author) {
  const a = stripCredentials(firstAuthorOnly(author || ''));
  if (!a) return '';
  const tokens = a.split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  if (tokens.length === 1) return tokens[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const firstInitial = (tokens[0].replace(/[^a-z0-9]/gi, '')[0] || '').toLowerCase();
  const lastToken = tokens[tokens.length - 1].replace(/[^a-z0-9]/gi, '').toLowerCase();
  return firstInitial + lastToken;
}

// Extract the first author from a multi-author iTunes string. Used ONLY for
// the dedupe key — the displayed author string remains the full original.
//
// iTunes concatenates narrators and audiobook publishers into the artistName
// (e.g. "Nikolai Gogol, Classic Audiobooks & Hörbuch Klassiker"), which
// produces a dedupe key that doesn't collide with the canonical OL author
// ("Nikolai Gogol"). This helper isolates the first author by:
//   1. Splitting on " & " (space-ampersand-space) — take the first chunk.
//   2. If that chunk contains ", " AND the part before the comma has ≥2
//      whitespace-separated tokens, take only the part before the comma.
//      This split is gated on ≥2 tokens so we preserve "Gogol, Nikolai"
//      (lastname-first format, 1 token before the comma) intact while
//      splitting "Nikolai Gogol, Classic Audiobooks" (2 tokens) at the comma.
export function firstAuthorOnly(author) {
  const s = (author || '').trim();
  if (!s) return '';
  const firstAmpChunk = s.split(' & ')[0].trim();
  const commaIdx = firstAmpChunk.indexOf(', ');
  if (commaIdx === -1) return firstAmpChunk;
  const head = firstAmpChunk.slice(0, commaIdx).trim();
  if (head.split(/\s+/).filter(Boolean).length >= 2) return head;
  return firstAmpChunk;
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
    isbn: (d.isbn || [])[0] || '',
    // #206: preserve language array so the post-merge filter can drop
    // foreign-language OL entries that would otherwise survive dedup
    // because their non-Latin author keys don't collide with Latin spellings.
    language: Array.isArray(d.language) ? d.language : []
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
 * Title pipeline: stripMarketingSubtitles(stripAllBracketed(stripFormatSuffix(title))).
 * Author pipeline: normalizeAuthorKey(stripCredentials(firstAuthorOnly(author))).
 */
export function omniboxDedupeKey(entry) {
  const e = entry || {};
  const cleanTitle = stripMarketingSubtitles(stripAllBracketed(stripFormatSuffix(e.title || '')));
  const titlePart = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
  const authorPart = normalizeAuthorKey(stripCredentials(firstAuthorOnly(e.author || '')));
  return titlePart + '|' + authorPart;
}

/**
 * Merge iTunes and OL normalized result arrays into a deduped entry list.
 *
 * Iteration order is [...itunesResults, ...olResults] (iTunes first); the
 * first entry seen for a given dedup key wins, so an iTunes hit suppresses
 * a matching OL hit. When a later duplicate carries a work_key or isbn the
 * survivor lacks, those values transfer to the survivor. The survivor's
 * display `title` is set to
 *   stripMarketingSubtitles(stripAllBracketed(stripFormatSuffix(rawTitle))).
 * The survivor's display `author` is left as the full original string —
 * firstAuthorOnly is applied to the KEY only.
 *
 * Pure: no DOM, no fetch, no app state.
 */
export function mergeOmniboxResults({ itunesResults = [], olResults = [], query = '' } = {}) {
  const combined = [];
  const seen = new Map();
  for (const r of [...itunesResults, ...olResults]) {
    const cleanTitle = stripMarketingSubtitles(stripAllBracketed(stripFormatSuffix(r.title || '')));
    const k = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '') + '|' +
              normalizeAuthorKey(stripCredentials(firstAuthorOnly(r.author || '')));
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
  // Secondary pass (#205): collapse middle-name-variant duplicates that the
  // primary key missed. Safe because we require title-key match too, so
  // surname+first-initial collisions only fire when the entries are already
  // known to be writing about the same canonical work.
  for (let i = 0; i < combined.length; i++) {
    const ti = combined[i].title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const ki = firstInitialKey(combined[i].author);
    if (!ti || !ki) continue;
    for (let j = i + 1; j < combined.length; j++) {
      const tj = combined[j].title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const kj = firstInitialKey(combined[j].author);
      if (ti === tj && ki === kj) {
        const dropped = combined[j];
        if (dropped.work_key && !combined[i].work_key) combined[i].work_key = dropped.work_key;
        if (dropped.isbn && !combined[i].isbn) combined[i].isbn = dropped.isbn;
        combined.splice(j, 1);
        j--;
      }
    }
  }
  // #206: drop OL entries whose language array contains only non-English values.
  // iTunes entries pass this filter (audiobook catalog doesn't expose language
  // reliably); their language is handled by the #212 title heuristic below.
  // OL entries with no language data are kept (conservative — isEnglish
  // returns true on undefined).
  let filtered = combined.filter(e => e.source !== 'ol' || isEnglish(e));

  // #212: title-language heuristic for entries whose language wasn't caught
  // by #206 (iTunes audiobooks, or OL entries with missing/sparse language
  // data). Only applies when (a) a query was passed AND (b) the query
  // itself doesn't look foreign — a user typing "la vida del lazarillo
  // de tormes" should still see Spanish editions. No-op when called
  // without a query (preserves backward compat).
  if (query && !isLikelyForeign(query)) {
    filtered = filtered.filter(e => !isLikelyForeign(e.title || ''));
  }

  // #208: tertiary suffix-collapse pass. For pairs sharing author-key, if
  // one's title-key is a strict suffix of the other's (and the shared
  // suffix is ≥10 chars after normalization), collapse them. Catches
  // series-prefix variants ("The Lord of the Rings: The Fellowship of the
  // Ring" → "The Fellowship of the Ring"), omnibuses ("Animal Farm /
  // Nineteen Eighty-Four" → "Nineteen Eighty-Four"), and similar shapes.
  // Word-boundary safeguard in the un-stripped title prevents accidental
  // matches inside words. Prefix-shape branch:
  //   - article-only prefix ("A ", "An ", "The "): drop the SHORTER (the
  //     canonical form has the article; OL sometimes stores titles without
  //     it as "Bend In The River" vs "A Bend in the River").
  //   - any other prefix (series tag, edition tag, omnibus): drop the LONGER.
  const dropForCollapse = new Set();
  for (let i = 0; i < filtered.length; i++) {
    if (dropForCollapse.has(i)) continue;
    const ti = (filtered[i].title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ki = normalizeAuthorKey(stripCredentials(firstAuthorOnly(filtered[i].author || '')));
    if (!ti || !ki) continue;
    for (let j = i + 1; j < filtered.length; j++) {
      if (dropForCollapse.has(j)) continue;
      const tj = (filtered[j].title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const kj = normalizeAuthorKey(stripCredentials(firstAuthorOnly(filtered[j].author || '')));
      if (!kj || kj !== ki) continue;

      let longerIdx, shorterIdx;
      if (ti.length < tj.length && tj.endsWith(ti) && ti.length >= 10) {
        shorterIdx = i; longerIdx = j;
      } else if (tj.length < ti.length && ti.endsWith(tj) && tj.length >= 10) {
        shorterIdx = j; longerIdx = i;
      } else continue;

      const longerLower = (filtered[longerIdx].title || '').toLowerCase();
      const shorterLower = (filtered[shorterIdx].title || '').toLowerCase();
      const idx = longerLower.lastIndexOf(shorterLower);
      if (idx <= 0) continue;
      if (/[a-zà-ÿ]/.test(longerLower[idx - 1])) continue;
      const prefix = longerLower.slice(0, idx);
      const isArticlePrefix = /^(a|an|the)\s+$/i.test(prefix);
      const dropIdx = isArticlePrefix ? shorterIdx : longerIdx;
      const keepIdx = isArticlePrefix ? longerIdx : shorterIdx;

      const dropped = filtered[dropIdx];
      const survivor = filtered[keepIdx];
      if (dropped.work_key && !survivor.work_key) survivor.work_key = dropped.work_key;
      if (dropped.isbn && !survivor.isbn) survivor.isbn = dropped.isbn;
      dropForCollapse.add(dropIdx);
      if (dropIdx === i) break;
    }
  }
  if (dropForCollapse.size) {
    filtered = filtered.filter((_, idx) => !dropForCollapse.has(idx));
  }

  // #210: score-based rerank with quality filter. Bubbles exact-title matches
  // above iTunes's native order, but enforces a hard top-5 cap on low-quality
  // OL entries so sparse-data noise can't displace canonical results just
  // because their bare title string-matches the query.
  // No-op when caller doesn't pass `query` (preserves backward compat for any
  // test or internal call that doesn't carry the search term).
  if (!query) return filtered;
  const queryTokens = tokenize(query);
  const scored = filtered.map((e, idx) => {
    const result = scoreDocument({
      title: e.title || '',
      subtitle: '',
      author: e.author || '',
      queryTokens,
      queryString: query,
      sortMode: 'relevance',
      year: 0,
    });
    return { e, idx, s: result.score, hq: isHighQualityForRerank(e) };
  });
  // Sort by score desc; preserve stability via original index on ties.
  scored.sort((a, b) => b.s - a.s || a.idx - b.idx);
  // Hard top-5 cap: high-quality entries fill the first 5 positions in score
  // order; everything else streams after (also in score order). When fewer
  // than 5 HQ entries exist, LQ fills the remainder of top-5.
  const hq = scored.filter(x => x.hq);
  const lq = scored.filter(x => !x.hq);
  const out = [];
  let hi = 0, li = 0;
  for (let pos = 0; pos < scored.length; pos++) {
    if (pos < 5 && hi < hq.length) out.push(hq[hi++]);
    else if (li < lq.length) out.push(lq[li++]);
    else if (hi < hq.length) out.push(hq[hi++]);
  }
  return out.map(x => x.e);
}
