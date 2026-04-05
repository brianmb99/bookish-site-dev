// cover_pipeline.js
// Extracted pure and async functions from book_search.js for testability.
import { rankCover } from './search_core.js';

/**
 * Minimum blob size (bytes) to consider a cover image real (not a placeholder).
 */
export const MIN_COVER_BYTES = 2000;

/**
 * Parse OpenLibrary search API JSON into normalized edition objects.
 * @param {Object} json - Raw OL API response
 * @returns {Array} Normalized edition objects
 */
export function parseOLSearchResponse(json) {
  return (json.docs || []).map(d => ({
    key: d.key || '',
    title: d.title || '',
    subtitle: d.subtitle || '',
    author_name: d.author_name || [],
    first_publish_year: d.first_publish_year || 0,
    cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '',
    isbn: d.isbn || [],
    language: d.language || []
  })).filter(Boolean);
}

/**
 * Check if an edition is English (or has no language data - defaults true).
 */
export function isEnglishBook(doc) {
  if (!doc.language || !Array.isArray(doc.language) || !doc.language.length) return true;
  return doc.language.some(l => l === 'eng' || l === 'en' || l === 'English');
}

/**
 * Sort comparator: editions with covers first, no-cover editions last.
 */
export function editionCoverSort(a, b) {
  return (a.cover_url ? 0 : 1) - (b.cover_url ? 0 : 1);
}

/**
 * Build normalized OL edition objects from raw API entries.
 * Filters to English editions (falls back to all if none found),
 * deduplicates by cover URL, sorts covers first.
 * @param {Array} rawEntries - Raw entries from OL /works/{id}/editions.json
 * @returns {{ editions: Array, seenCovers: Set }}
 */
export function buildOLEditions(rawEntries) {
  const olEditions = rawEntries.map(e => ({
    title: e.title || '',
    author_name: [],
    cover_url: e.covers && e.covers.length
      ? `https://covers.openlibrary.org/b/id/${e.covers[0]}-L.jpg` : '',
    language: e.languages
      ? e.languages.map(l => (l.key || '').replace('/languages/', '')) : []
  }));
  const engOnly = olEditions.filter(e => isEnglishBook(e));
  let baseEditions = (engOnly.length ? engOnly : olEditions).slice();
  const seenCovers = new Set();
  baseEditions = baseEditions.filter(e => {
    if (!e.cover_url) return true;
    if (seenCovers.has(e.cover_url)) return false;
    seenCovers.add(e.cover_url);
    return true;
  });
  baseEditions.sort(editionCoverSort);
  return { editions: baseEditions, seenCovers };
}

/**
 * Insert an edition into a rank-sorted array (highest rank first).
 * Mutates the array in place. Returns the insertion index.
 */
export function insertByRank(editions, newEdition) {
  for (let i = 0; i < editions.length; i++) {
    if ((editions[i]._rank || 0) < (newEdition._rank || 0)) {
      editions.splice(i, 0, newEdition);
      return i;
    }
  }
  editions.push(newEdition);
  return editions.length - 1;
}

/**
 * Build a cover edition object from a validated cover result.
 * Uses rankCover from search_core.js.
 */
export function buildCoverEdition(coverData, meta) {
  return {
    title: meta.title || '',
    author_name: [],
    cover_url: coverData.url,
    _coverData: coverData,
    _rank: rankCover(coverData)
  };
}

/**
 * Default image dimension getter using Image element.
 * Separated for testability - tests can inject a mock via deps.getImageDims.
 */
export function defaultGetImageDims(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Fetch, validate, and measure a cover image.
 * Returns cover data object or null if invalid/failed.
 *
 * @param {string} url - Image URL to fetch
 * @param {string} source - Source label ("amazon" or "ol")
 * @param {Object} [deps] - Injectable dependencies for testing
 * @param {Function} [deps.fetchFn] - fetch implementation (default: global fetch)
 * @param {Function} [deps.resizeFn] - resizeImageToBase64 implementation
 * @param {Function} [deps.getImageDims] - async fn(dataUrl) => {w,h} or null
 * @returns {Promise<Object|null>}
 */
export async function fetchAndValidateCover(url, source, deps = {}) {
  const {
    fetchFn = globalThis.fetch,
    resizeFn,
    getImageDims = defaultGetImageDims
  } = deps;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const resp = await fetchFn(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (blob.size < MIN_COVER_BYTES) return null;
    const { base64, mime, wasResized, dataUrl } = await resizeFn(blob);
    const dims = await getImageDims(dataUrl);
    if (!dims || dims.w <= 10 || dims.h <= 10) return null;
    return { url, source, base64, mime, dataUrl, width: dims.w, height: dims.h };
  } catch { return null; }
}
