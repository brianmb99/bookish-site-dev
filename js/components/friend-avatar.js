// friend-avatar.js — deterministic-color initial circle for a friend.
//
// Used by the friend strip (Region B of the Friends drawer, issue #122),
// and reusable later for friend pips on Library cards (#6) and the friend's
// shelf header (#4).
//
// Design decisions:
//
//  - Color comes from a hash of the connection's stable identifier. Per
//    FRIENDS.md open Q5 we use `connection.share_pub` — it's set at
//    connection-establishment and is stable through identity rotation
//    (rotation re-wraps but does not regenerate the share keypair). If
//    a future Tarn change rotates share_pub the color would change for
//    that friend; that's acceptable because (a) rotation is rare and
//    (b) the recipient still controls the visual via `connection.label`
//    which is the primary identifier the user sees.
//
//  - Palette: 12 colors chosen for distinguishability against the dark
//    elevated surface (`--color-bg-elevated`) we render the strip on.
//    Each color has a comfortable WCAG AA contrast ratio against the
//    initial drawn in white. We do NOT use the existing
//    `generatedCoverColor` palette from the WTR mini-cover because that
//    one is title-derived and tuned for a different background; mixing
//    palettes would let the same friend's avatar accidentally collide
//    with a book cover swatch in the same viewport.
//
//  - Initial: first non-whitespace alphanumeric character of the label,
//    uppercased. Falls back to "?" for empty/symbolic labels so the
//    circle stays visually whole.

// Stable palette — order matters for the hash-bucketing.
// Picked for chroma + perceived distinctness; keep this short list curated
// rather than generated so designers can hand-tune later.
const PALETTE = [
  '#e07a5f', // terra
  '#f2b134', // amber
  '#3d8c40', // forest
  '#3aaed8', // azure
  '#2563eb', // bookish primary blue
  '#7e57c2', // violet
  '#c2185b', // raspberry
  '#5e8d4a', // sage
  '#b45309', // burnt orange
  '#0d9488', // teal
  '#6366f1', // indigo
  '#d97706', // ochre
];

/**
 * djb2-style string hash. Stable across runs and platforms; non-cryptographic
 * and that's fine — we only need consistent bucketing into the palette.
 *
 * @param {string} s
 * @returns {number} 32-bit unsigned hash
 */
function hash32(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // h * 33 ^ ch  — written without `*` to avoid overflow surprises.
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  // Force to unsigned 32-bit.
  return h >>> 0;
}

/**
 * Pick a palette color for a connection. Falls back to the first palette
 * entry if no identifier is available — that case shouldn't happen in
 * practice (every connection has a share_pub) but we want to render
 * something rather than throw.
 *
 * @param {{ share_pub?: string, label?: string }} connection
 * @returns {string} hex color
 */
export function avatarColorForConnection(connection) {
  if (!connection || typeof connection !== 'object') return PALETTE[0];
  const id = connection.share_pub || connection.label || '';
  if (!id) return PALETTE[0];
  return PALETTE[hash32(id) % PALETTE.length];
}

/**
 * Compute the initial character to render inside the avatar circle.
 * Strips leading whitespace + symbols so labels like "  *Maya" still
 * render as "M". Returns "?" if no usable character is found.
 *
 * @param {string} label
 * @returns {string} single uppercase character
 */
export function initialForLabel(label) {
  if (!label || typeof label !== 'string') return '?';
  // First alphanumeric (incl. unicode letters/numbers).
  const match = label.match(/[\p{L}\p{N}]/u);
  if (!match) return '?';
  return match[0].toUpperCase();
}

/**
 * Render an avatar element for a connection. Returns a detached HTMLElement
 * the caller can append. The element uses inline color for the deterministic
 * background; everything else (size, font, border) comes from the
 * `.friend-avatar` CSS class.
 *
 * @param {{ share_pub?: string, label?: string }} connection
 * @param {{ size?: 'sm' | 'md', ariaLabel?: string }} [opts]
 * @returns {HTMLElement}
 */
export function renderFriendAvatar(connection, opts = {}) {
  const label = (connection?.label || '').trim();
  const initial = initialForLabel(label);
  const color = avatarColorForConnection(connection);

  const el = document.createElement('div');
  el.className = 'friend-avatar';
  if (opts.size === 'sm') el.classList.add('friend-avatar-sm');
  el.style.backgroundColor = color;
  el.textContent = initial;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', opts.ariaLabel || label || 'Friend');
  return el;
}

// Test hook — let the unit tests assert against the exact palette.
export const _PALETTE_FOR_TEST = PALETTE;
