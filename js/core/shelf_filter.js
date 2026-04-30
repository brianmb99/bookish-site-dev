// shelf_filter.js — Pure functions for shelf search filtering and year-grouped display

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
 * Group entries by year extracted from dateRead.
 * "Currently reading" books (readingStatus === 'reading') are placed in the current year.
 * Entries without dateRead go into "Undated" at the end.
 * Returns a Map ordered by year descending, with "Undated" last.
 *
 * `dateRead` is a ms-epoch number (schema v0.3.0). Year is read in UTC so the
 * grouping matches the calendar day the user picked, regardless of viewer
 * timezone.
 *
 * @param {Array} entries - book entries (already sorted within each status group)
 * @returns {Map<string, Array>} year -> entries, ordered by year desc, "Undated" last
 */
export function groupByYear(entries) {
  const yearMap = new Map();
  const undated = [];
  const currentYear = new Date().getFullYear().toString();

  for (const e of entries) {
    // Currently reading books go into the current year
    if (e.readingStatus === 'reading') {
      if (!yearMap.has(currentYear)) yearMap.set(currentYear, []);
      yearMap.get(currentYear).push(e);
      continue;
    }
    let year = null;
    if (e.dateRead != null && e.dateRead !== '') {
      const d = new Date(e.dateRead);
      if (!isNaN(d.getTime())) year = String(d.getUTCFullYear());
    }
    if (year && /^\d{4}$/.test(year)) {
      if (!yearMap.has(year)) yearMap.set(year, []);
      yearMap.get(year).push(e);
    } else {
      undated.push(e);
    }
  }

  // Sort years descending
  const sortedYears = [...yearMap.keys()].sort((a, b) => b.localeCompare(a));
  const result = new Map();
  for (const y of sortedYears) {
    result.set(y, yearMap.get(y));
  }
  if (undated.length) {
    result.set('Undated', undated);
  }

  return result;
}

/**
 * Get sorted list of years from a year-grouped map (for spine navigator).
 * @param {Map<string, Array>} yearGroups - from groupByYear()
 * @returns {Array<{year: string, count: number}>}
 */
export function getYearList(yearGroups) {
  return [...yearGroups.entries()].map(([year, entries]) => ({
    year,
    count: entries.length,
  }));
}

/**
 * Determine the default selected year: current year if it has books,
 * otherwise the most recent year with books.
 * @param {Map<string, Array>} yearGroups - from groupByYear()
 * @returns {string|null} year string or null if no books
 */
export function getDefaultYear(yearGroups) {
  if (yearGroups.size === 0) return null;
  const currentYear = new Date().getFullYear().toString();
  if (yearGroups.has(currentYear)) return currentYear;
  // First key is most recent year (Map is ordered desc)
  return yearGroups.keys().next().value;
}

/**
 * Find the nearest populated year when the current year becomes empty.
 * Prefers the next more-recent year, falls back to the next older year.
 * @param {Map<string, Array>} yearGroups - from groupByYear()
 * @param {string} emptyYear - the year that just became empty
 * @returns {string|null} nearest populated year, or null if no years remain
 */
export function getNearestPopulatedYear(yearGroups, emptyYear) {
  const years = [...yearGroups.keys()].filter(y => y !== emptyYear);
  if (years.length === 0) return null;

  // For 'Undated', just return the first (most recent) numeric year
  if (emptyYear === 'Undated' || !/^\d{4}$/.test(emptyYear)) {
    return years[0];
  }

  const numericYears = years.filter(y => /^\d{4}$/.test(y));
  // Prefer a more-recent year first, then older, then 'Undated'
  const moreRecent = numericYears.filter(y => y > emptyYear).sort((a, b) => a.localeCompare(b));
  if (moreRecent.length) return moreRecent[0]; // closest newer year

  const older = numericYears.filter(y => y < emptyYear).sort((a, b) => b.localeCompare(a));
  if (older.length) return older[0]; // closest older year

  // Only 'Undated' remains
  return years.includes('Undated') ? 'Undated' : years[0];
}

/**
 * Build the display list for the shelf, handling search + year grouping + WTR merging
 * @param {Object} opts
 * @param {Array} opts.shelfEntries - reading + read entries (already sorted)
 * @param {Array} opts.wantList - want-to-read entries (already sorted)
 * @param {string} opts.searchQuery - current search term (trimmed)
 * @param {string|null} opts.selectedYear - currently selected year (null = default)
 * @returns {{ displayEntries: Array, matchCount: number|null, isSearching: boolean, yearGroups: Map, activeYear: string|null }}
 */
export function buildDisplayList({ shelfEntries, wantList, searchQuery, selectedYear }) {
  const yearGroups = groupByYear(shelfEntries);

  const isSearching = searchQuery.length > 0;

  if (isSearching) {
    const shelfMatches = filterBySearch(shelfEntries, searchQuery).map(e => ({ ...e, _wtrResult: false }));
    const wtrMatches = filterBySearch(wantList, searchQuery).map(e => ({ ...e, _wtrResult: true }));
    const displayEntries = [...shelfMatches, ...wtrMatches];
    return {
      displayEntries,
      matchCount: displayEntries.length,
      isSearching: true,
      yearGroups,
      activeYear: selectedYear || getDefaultYear(yearGroups),
    };
  }

  // Default: show selected year's books
  const activeYear = selectedYear || getDefaultYear(yearGroups);
  const displayEntries = activeYear && yearGroups.has(activeYear) ? yearGroups.get(activeYear) : [];
  return {
    displayEntries,
    matchCount: null,
    isSearching: false,
    yearGroups,
    activeYear,
  };
}
