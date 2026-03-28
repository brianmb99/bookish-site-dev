// shelf_filter.js — Pure functions for shelf search filtering and pagination

/**
 * Filter entries by search query (substring match on title and author, case-insensitive)
 * @param {Array} entries - book entries to filter
 * @param {string} query - search string (already trimmed)
 * @returns {Array} matching entries
 */
export function filterBySearch(entries, query) {
  if (!query) return entries;
  const q = query.toLowerCase();
  return entries.filter(e => {
    const t = (e.title || '').toLowerCase();
    const a = (e.author || '').toLowerCase();
    return t.includes(q) || a.includes(q);
  });
}

/**
 * Apply pagination to a list of entries
 * @param {Array} entries - full list
 * @param {number} limit - max items to show
 * @returns {{ page: Array, remaining: number }}
 */
export function paginate(entries, limit) {
  if (entries.length <= limit) {
    return { page: entries, remaining: 0 };
  }
  return {
    page: entries.slice(0, limit),
    remaining: entries.length - limit,
  };
}

/**
 * Build the display list for the shelf, handling search + pagination + WTR merging
 * @param {Object} opts
 * @param {Array} opts.shelfEntries - reading + read entries (already sorted)
 * @param {Array} opts.wantList - want-to-read entries (already sorted)
 * @param {string} opts.searchQuery - current search term (trimmed)
 * @param {number} opts.visibleLimit - current pagination limit
 * @returns {{ displayEntries: Array, matchCount: number|null, remaining: number, isSearching: boolean }}
 */
export function buildDisplayList({ shelfEntries, wantList, searchQuery, visibleLimit }) {
  const isSearching = searchQuery.length > 0;

  if (isSearching) {
    const shelfMatches = filterBySearch(shelfEntries, searchQuery).map(e => ({ ...e, _wtrResult: false }));
    const wtrMatches = filterBySearch(wantList, searchQuery).map(e => ({ ...e, _wtrResult: true }));
    const displayEntries = [...shelfMatches, ...wtrMatches];
    return {
      displayEntries,
      matchCount: displayEntries.length,
      remaining: 0,
      isSearching: true,
    };
  }

  const { page, remaining } = paginate(shelfEntries, visibleLimit);
  return {
    displayEntries: page,
    matchCount: null,
    remaining,
    isSearching: false,
  };
}
