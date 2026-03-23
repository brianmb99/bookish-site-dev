// search_core.js - Pure search logic extracted from book_search.js
// Tokenization, scoring, filtering, sorting, OpenLibrary merge

const STOPWORDS = new Set(['the', 'and', 'of', 'a', 'an', 'to', 'in', 'on', 'for', 'by', 'with', 'at', 'from']);

// Tokenize query: lowercase, split on non-alphanumeric, filter short words and stopwords
export function tokenize(query) {
  return query.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t && t.length > 2 && !STOPWORDS.has(t));
}

// Extract base title (before colon if present)
export function baseTitle(query) {
  const idx = query.indexOf(':');
  return idx > 2 ? query.slice(0, idx).trim() : query.trim();
}

// Merge two OpenLibrary doc lists, deduplicating by key
export function mergeOpenLibrary(listA, listB) {
  const map = new Map();

  function add(doc, src) {
    if (!doc || !doc.key) return;
    if (!map.has(doc.key)) {
      map.set(doc.key, { ...doc, _src: src });
    } else {
      // Merge publish_year arrays
      const existing = map.get(doc.key);
      if (Array.isArray(doc.publish_year)) {
        existing.publish_year = Array.isArray(existing.publish_year)
          ? [...new Set(existing.publish_year.concat(doc.publish_year))]
          : doc.publish_year;
      }
      if (!existing.subtitle && doc.subtitle) existing.subtitle = doc.subtitle;
      if (existing._src !== src) existing._src = 'both';
    }
  }

  listA.forEach(d => add(d, 'title'));
  listB.forEach(d => add(d, 'broad'));

  return Array.from(map.values());
}

// Enrich documents with computed year
export function enrichWithYear(docs) {
  docs.forEach(d => {
    if (d._yearComputed !== undefined) return;
    let y = 0;
    if (Array.isArray(d.publish_year) && d.publish_year.length) {
      y = Math.max(...d.publish_year);
    } else if (d.first_publish_year) {
      y = d.first_publish_year;
    }
    d._yearComputed = y || 0;
  });
}

// Enrich iTunes items with computed year
export function enrichItunesWithYear(items) {
  items.forEach(i => {
    if (i._yearComputed === undefined) {
      i._yearComputed = i.releaseDate ? parseInt(i.releaseDate.slice(0, 4), 10) || 0 : 0;
    }
  });
}

// Score a document based on query tokens
// Returns: { score, coverage, strict }
export function scoreDocument({ title, subtitle, author, queryTokens, queryString, sortMode = 'relevance', year = 0 }) {
  const fullTitle = (title || '') + (subtitle ? (' ' + subtitle) : '');
  const lower = fullTitle.toLowerCase();
  const lowerAuthor = (author || '').toLowerCase();

  // Coverage: fraction of tokens present
  let presentTokens = 0;
  queryTokens.forEach(t => {
    if (lower.includes(t) || lowerAuthor.includes(t)) {
      presentTokens++;
    }
  });
  const coverage = queryTokens.length > 0 ? presentTokens / queryTokens.length : 0;

  // Bonus scoring
  const lowerQuery = queryString.toLowerCase();
  const exactEq = lower.trim() === lowerQuery ? 1 : 0;
  const starts = lower.startsWith(lowerQuery) ? 1 : 0;
  const phrase = lower.includes(lowerQuery) ? 1 : 0;

  let score = coverage * 100 + exactEq * 150 + starts * 40 + phrase * 25;

  // Recency influence if relevance mode
  if (sortMode === 'relevance') {
    score += (year || 0) * 0.02;
  }

  // Strict: all tokens present in title/subtitle/author
  const titleBlob = ((title || '') + ' ' + (subtitle || '') + ' ' + (author || '')).toLowerCase();
  let strict = queryTokens.length > 0;
  queryTokens.forEach(t => {
    if (!titleBlob.includes(t)) strict = false;
  });

  return { score, coverage, strict };
}

// Filter documents by language (English-only)
// Keeps: docs with no language info, docs that include English
export function isEnglish(doc) {
  if (!doc.language || !Array.isArray(doc.language) || doc.language.length === 0) return true;
  return doc.language.some(l => l === 'eng' || l === 'en' || l === 'English');
}

// Filter documents by source: 'all' (books + audiobooks) or 'audiobook' (iTunes only)
export function passesFilter(item, activeFilter) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'audiobook') return !!item._isItunes;
  return true;
}

// Deduplicate documents by normalized title+author key.
// Groups variants, picks best display names, collects all covers/work keys.
export function deduplicateByDisplay(docs) {
  const groups = new Map();
  docs.forEach(d => {
    const key = displayKeyOpenLibrary(d);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  });
  return Array.from(groups.values()).map(group => {
    group.sort((a, b) => (b._score || 0) - (a._score || 0) || (b.cover_i ? 1 : 0) - (a.cover_i ? 1 : 0));
    const rep = { ...group[0] };
    const authors = group.map(d => (d.author_name && d.author_name[0]) || '').filter(Boolean);
    if (authors.length) rep._bestAuthor = pickBestName(authors, 3);
    const titles = group.map(d => cleanTitle(d.title || '')).filter(Boolean);
    if (titles.length) rep._bestTitle = pickBestName(titles);
    rep._allCovers = [...new Set(group.map(d => d.cover_i).filter(Boolean))];
    rep._allWorkKeys = [...new Set(group.map(d => d.key).filter(Boolean))];
    return rep;
  });
}

/** Normalized title|author key for an OpenLibrary work. */
export function displayKeyOpenLibrary(doc) {
  const title = normalizeTitleKey(doc.title || '');
  const author = normalizeAuthorKey((doc.author_name && doc.author_name[0]) || '');
  return `${title}|${author}`;
}

/** Normalized title|author key for an iTunes search hit. */
export function displayKeyItunes(item) {
  const title = normalizeTitleKey(item.collectionName || item.trackName || '');
  const author = normalizeAuthorKey(item.artistName || '');
  return `${title}|${author}`;
}

/** Dedupe iTunes rows by normalized key, picking best display names. */
export function deduplicateItunesByDisplay(items) {
  const groups = new Map();
  (items || []).forEach(i => {
    const key = displayKeyItunes(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  return Array.from(groups.values()).map(group => {
    group.sort((a, b) => (b._score || 0) - (a._score || 0));
    const rep = { ...group[0] };
    const authors = group.map(i => i.artistName || '').filter(Boolean);
    if (authors.length) rep._bestAuthor = pickBestName(authors, 3);
    const titles = group.map(i => cleanTitle(i.collectionName || i.trackName || '')).filter(Boolean);
    if (titles.length) rep._bestTitle = pickBestName(titles);
    return rep;
  });
}

/**
 * Drop OpenLibrary works that match any iTunes result.
 * Full key match (title+author), or title-only match when OL has no author.
 */
export function filterOlSupersededByItunes(olDocs, itunesItems) {
  const fullKeys = new Set();
  const titleKeys = new Set();
  (itunesItems || []).forEach(i => {
    fullKeys.add(displayKeyItunes(i));
    titleKeys.add(normalizeTitleKey(i.collectionName || i.trackName || ''));
  });
  return (olDocs || []).filter(d => {
    if (fullKeys.has(displayKeyOpenLibrary(d))) return false;
    const authorRaw = (d.author_name && d.author_name[0]) || '';
    if (!authorRaw.trim() && titleKeys.has(normalizeTitleKey(d.title || ''))) return false;
    return true;
  });
}

// Strip noise words/markers from titles (Unabridged, Abridged, trailing pub years)
const NOISE_RE = /\s*[\(\[](un)?abridged[\)\]]\s*/gi;
export function stripNoise(title) {
  if (!title) return '';
  let cleaned = title.replace(NOISE_RE, '').trim();
  const ym = cleaned.match(/^(.+?)\s+(1[89]\d{2}|20\d{2})\s*$/);
  if (ym) cleaned = ym[1].trim();
  return cleaned;
}

// Normalize author name for dedup keying: sorted initials + surname, all lowercase
export function normalizeAuthorKey(name) {
  if (!name) return '';
  const parts = name.replace(/[.,\-\u2010-\u2015\u2212]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const surname = parts[parts.length - 1].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const initials = parts.slice(0, -1)
    .map(p => (p.replace(/[^a-z0-9]/gi, '')[0] || '').toLowerCase())
    .filter(Boolean)
    .sort();
  return initials.join('') + surname;
}

// Normalize title for dedup keying: strip noise, all dashes→spaces, collapse whitespace, lowercase
export function normalizeTitleKey(title) {
  return stripNoise(title || '').replace(/[-\u2010-\u2015\u2212]/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
}

// Pick the best display name from a list of variants
// For authors: maxWords=3 (prefer spelled-out, properly cased, ≤3 words)
// For titles: omit maxWords
export function pickBestName(variants, maxWords) {
  if (!variants || !variants.length) return '';
  const cleaned = [...new Set(variants.map(v => (v || '').trim()).filter(Boolean))];
  if (!cleaned.length) return '';
  if (cleaned.length === 1) return cleaned[0];
  const limit = maxWords || Infinity;
  return cleaned.slice().sort((a, b) => {
    const aw = a.split(/\s+/), bw = b.split(/\s+/);
    const aOk = aw.length <= limit ? 1 : 0, bOk = bw.length <= limit ? 1 : 0;
    if (aOk !== bOk) return bOk - aOk;
    const aC = (a !== a.toLowerCase() && a !== a.toUpperCase()) ? 1 : 0;
    const bC = (b !== b.toLowerCase() && b !== b.toUpperCase()) ? 1 : 0;
    if (aC !== bC) return bC - aC;
    const aA = aw.filter(w => w.replace(/[^a-zA-Z]/g, '').length <= 1).length;
    const bA = bw.filter(w => w.replace(/[^a-zA-Z]/g, '').length <= 1).length;
    if ((aw.length - aA) !== (bw.length - bA)) return (bw.length - bA) - (aw.length - aA);
    return b.length - a.length;
  })[0];
}

// Title-case a string, but ONLY if it's ALL CAPS (preserves intentional mixed case)
const TITLE_MINOR = new Set(['a','an','the','and','but','or','nor','for','yet','so','in','on','at','to','of','by','up','as','is','if','it']);
export function toTitleCase(str) {
  if (!str) return '';
  if (str !== str.toUpperCase()) return str;
  return str.toLowerCase().replace(/\b\w+/g, (word, idx) => {
    if (idx > 0 && TITLE_MINOR.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

// Clean a title for display: strip noise, then title-case if ALL CAPS
export function cleanTitle(title) {
  return toTitleCase(stripNoise(title));
}

// Detect if query is an ISBN (10 or 13 digits, with optional hyphens/spaces)
// Returns { isISBN, isbn, isbnUrl } or { isISBN: false }
export function detectISBN(query) {
  const digits = query.replace(/[\s-]/g, '');
  if (/^\d{10}$/.test(digits) || /^\d{13}$/.test(digits)) {
    return {
      isISBN: true,
      isbn: digits,
      isbnUrl: `https://openlibrary.org/isbn/${digits}.json`
    };
  }
  return { isISBN: false };
}

// Parse "Title by Author" or natural language queries into components
// Returns { title, author } where author may be null
export function parseAuthorTitle(query) {
  const trimmed = query.trim();
  if (!trimmed) return { title: '', author: null };

  // Pattern: "Title by Author" (case-insensitive, requires 2+ chars on each side)
  const byMatch = trimmed.match(/^(.{2,}?)\s+by\s+(.{2,})$/i);
  if (byMatch) {
    return { title: byMatch[1].trim(), author: byMatch[2].trim() };
  }

  return { title: trimmed, author: null };
}

// Filter and sort combined results
export function filterAndSort({
  olDocs,
  itunesItems,
  activeFilter = 'all',
  sortMode = 'relevance',
  strictActive = false
}) {
  let ol = olDocs.slice();
  let it = itunesItems.slice();

  // Apply strict filter if active
  if (strictActive) {
    ol = ol.filter(d => d._strict);
    it = it.filter(i => i._strict);
  }

  // Filter non-English results
  ol = ol.filter(d => isEnglish(d));

  // Apply source filter: 'audiobook' hides OL results, 'all' keeps both
  if (activeFilter === 'audiobook') {
    ol = [];
  }

  // Sort
  if (sortMode === 'newest') {
    ol = [...ol].sort((a, b) => (b._yearComputed || 0) - (a._yearComputed || 0));
    it = [...it].sort((a, b) => (b._yearComputed || 0) - (a._yearComputed || 0));
  } else {
    // relevance: sort by score desc, then year desc
    ol = [...ol].sort((a, b) =>
      (b._score || 0) - (a._score || 0) || (b._yearComputed || 0) - (a._yearComputed || 0)
    );
    it = [...it].sort((a, b) =>
      (b._score || 0) - (a._score || 0) || (b._yearComputed || 0) - (a._yearComputed || 0)
    );
  }

  return { ol, it };
}
