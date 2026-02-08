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

  // Strict: all tokens present in title/subtitle
  const titleBlob = ((title || '') + ' ' + (subtitle || '')).toLowerCase();
  let strict = queryTokens.length > 0;
  queryTokens.forEach(t => {
    if (!titleBlob.includes(t)) strict = false;
  });

  return { score, coverage, strict };
}

// Filter documents by format
export function passesFilter(item, activeFilter) {
  if (activeFilter === 'all') return true;

  if (item._isItunes) {
    return activeFilter === 'audiobook';
  }

  // OpenLibrary format guess
  const fmt = (item.physical_format || '').toLowerCase();
  if (activeFilter === 'audiobook') return fmt.includes('audio');
  if (activeFilter === 'paperback') return fmt.includes('paper');
  if (activeFilter === 'hardcover') return fmt.includes('hard');

  return true;
}

// Deduplicate documents by display representation (title + author)
// Removes visually identical results even if they have different work keys
export function deduplicateByDisplay(docs) {
  const seen = new Set();
  return docs.filter(d => {
    const title = (d.title || '').toLowerCase().trim();
    const author = ((d.author_name && d.author_name[0]) || '').toLowerCase().trim();
    const key = `${title}|${author}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  // Apply format filter
  ol = ol.filter(d => passesFilter(d, activeFilter));

  // iTunes: only show if audiobook or all
  if (activeFilter !== 'audiobook' && activeFilter !== 'all') {
    it = [];
  } else {
    it = it.filter(() => activeFilter === 'all' || activeFilter === 'audiobook');
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
