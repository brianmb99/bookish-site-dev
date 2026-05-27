// cover_crop.js — non-destructive cover crop metadata helpers.
//
// Stored crop metadata is normalized so one crop works across the modal,
// bookshelf cards, WTR drawer, and smaller friend surfaces:
//   { v: 1, zoom: 1..3, x: panX/tileWidth, y: panY/tileHeight }

export const COVER_CROP_VERSION = 1;
export const MIN_COVER_ZOOM = 1;
export const MAX_COVER_ZOOM = 3;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function round(n, places) {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

function parseCrop(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (typeof value === 'object') return value;
  return null;
}

export function normalizeCoverCrop(value) {
  const raw = parseCrop(value);
  if (!raw) return null;

  const zoom = clamp(Number(raw.zoom ?? raw.z ?? 1) || 1, MIN_COVER_ZOOM, MAX_COVER_ZOOM);
  const maxPan = (zoom - 1) / 2;
  const x = clamp(Number(raw.x ?? raw.panX ?? 0) || 0, -maxPan, maxPan);
  const y = clamp(Number(raw.y ?? raw.panY ?? 0) || 0, -maxPan, maxPan);

  if (zoom <= MIN_COVER_ZOOM + 0.0001 && Math.abs(x) < 0.0001 && Math.abs(y) < 0.0001) {
    return null;
  }

  return {
    v: COVER_CROP_VERSION,
    zoom: round(zoom, 3),
    x: round(x, 4),
    y: round(y, 4),
  };
}

export function serializeCoverCrop(value) {
  const crop = normalizeCoverCrop(value);
  return crop ? JSON.stringify(crop) : '';
}

export function coverCropTransform(value) {
  const crop = normalizeCoverCrop(value);
  if (!crop) return '';
  const xPct = round(crop.x * 100, 3);
  const yPct = round(crop.y * 100, 3);
  return `translate(${xPct}%, ${yPct}%) scale(${crop.zoom})`;
}

export function coverCropStyle(value) {
  const transform = coverCropTransform(value);
  return transform ? `transform:${transform};transform-origin:center center;` : '';
}

export function coverCropStyleAttr(value) {
  const style = coverCropStyle(value);
  return style ? ` style="${style}"` : '';
}

export function applyCoverCropToImage(img, value) {
  if (!img) return null;
  const crop = normalizeCoverCrop(value);
  if (crop) {
    img.style.transform = coverCropTransform(crop);
    img.style.transformOrigin = 'center center';
  } else {
    img.style.transform = '';
    img.style.transformOrigin = '';
  }
  return crop;
}
