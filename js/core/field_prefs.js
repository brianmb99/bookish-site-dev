// field_prefs.js — Per-device user preferences for optional book-field visibility (#104)
//
// Stored in localStorage so preferences stay on this device. Deliberately NOT
// synced through Tarn — the preference is inherently device-contextual (a user
// may want different defaults on mobile vs desktop), and keeping it local
// avoids schema changes and backend dependencies.
//
// Usage:
//   import { getFieldPref, setFieldPref, FIELDS } from './core/field_prefs.js';
//   if (getFieldPref('rating')) { /* show rating */ }
//   setFieldPref('rating', true);   // persist the user's explicit choice

const STORAGE_KEY = 'bookish.fieldPrefs';

/** The four optional fields controlled by user preferences. */
export const FIELDS = ['notes', 'rating', 'owned', 'tags'];

/** Defaults for new users — everything hidden (matches pre-#104 behavior). */
const DEFAULTS = Object.fromEntries(FIELDS.map(f => [f, false]));

// In-memory fallback when localStorage is unavailable (Safari private mode,
// quota exceeded, iframe without storage access). We still honor set/get for
// the current session so the UI isn't broken; the value just doesn't persist.
let _memoryCache = null;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    // Defensive: ensure all fields are present and booleans
    const result = { ...DEFAULTS };
    for (const f of FIELDS) {
      if (typeof parsed[`show${capitalize(f)}ByDefault`] === 'boolean') {
        result[f] = parsed[`show${capitalize(f)}ByDefault`];
      }
    }
    return result;
  } catch {
    // Corrupt JSON or localStorage blocked — fall through to defaults
    if (_memoryCache) return { ..._memoryCache };
    return { ...DEFAULTS };
  }
}

function savePrefs(prefs) {
  const serialized = {};
  for (const f of FIELDS) {
    serialized[`show${capitalize(f)}ByDefault`] = !!prefs[f];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // localStorage unavailable — keep in-memory fallback
    _memoryCache = { ...prefs };
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Get the preference for a single field. Returns false if the field is unknown
 * or if localStorage is inaccessible and no in-memory fallback exists.
 * @param {string} fieldName — one of FIELDS ('notes', 'rating', 'owned', 'tags')
 * @returns {boolean}
 */
export function getFieldPref(fieldName) {
  if (!FIELDS.includes(fieldName)) return false;
  const prefs = loadPrefs();
  return !!prefs[fieldName];
}

/**
 * Set the preference for a single field. Silently no-ops for unknown fields.
 * @param {string} fieldName — one of FIELDS
 * @param {boolean} show — true to show by default, false to hide by default
 */
export function setFieldPref(fieldName, show) {
  if (!FIELDS.includes(fieldName)) return;
  const prefs = loadPrefs();
  prefs[fieldName] = !!show;
  savePrefs(prefs);
}

/**
 * Get all field preferences at once. Useful for initialization.
 * @returns {Object.<string, boolean>}
 */
export function getAllFieldPrefs() {
  return loadPrefs();
}

/** Test-only helper: clear all preferences and reset to defaults. */
export function _resetForTesting() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  _memoryCache = null;
}
