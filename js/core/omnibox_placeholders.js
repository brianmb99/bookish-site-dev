// omnibox_placeholders.js — Rotating placeholder pool for the omnibox input.
//
// On each page load we pick one entry from the pool and render it as the
// placeholder for `#omniboxInput`. This replaces the static "Try: ..."
// example line that used to live below the omnibox on the empty state
// (removed in #149). Each placeholder reads as a hint ("Search for 'X'
// or any book…"), not as content, and rotates so first-run users see a
// different example title across visits without us having to maintain
// dedicated UI surface for example queries.
//
// Pure module — no DOM, no globals. The pool is exported for tests; the
// `pickRandom` helper takes an optional RNG seed so tests can be
// deterministic. `formatPlaceholder` builds the final string from a title.

export const PLACEHOLDER_TITLES = Object.freeze([
  'Project Hail Mary',
  'The Overstory',
  'Pachinko',
  'Sapiens',
  'Atomic Habits',
  'The Body Keeps the Score',
]);

/**
 * Format a title as a placeholder string in the canonical shape.
 * Uses a single ellipsis codepoint (…) not three dots.
 *
 * @param {string} title
 * @returns {string}
 */
export function formatPlaceholder(title) {
  return `Search for '${title}' or any book…`;
}

/**
 * Pick a random title from PLACEHOLDER_TITLES. `rng` is an optional
 * function returning [0, 1) — defaults to Math.random. Returns one of
 * the strings from the pool; never undefined.
 *
 * @param {() => number} [rng]
 * @returns {string}
 */
export function pickRandomTitle(rng = Math.random) {
  const idx = Math.floor(rng() * PLACEHOLDER_TITLES.length);
  // Clamp defensively in case rng() returns >= 1 (some seeded PRNGs).
  return PLACEHOLDER_TITLES[Math.min(idx, PLACEHOLDER_TITLES.length - 1)];
}

/**
 * One-shot helper: pick a random title and format it.
 *
 * @param {() => number} [rng]
 * @returns {string}
 */
export function pickRandomPlaceholder(rng = Math.random) {
  return formatPlaceholder(pickRandomTitle(rng));
}
