// image_utils.js - Image processing utilities for cover downsampling
// Resizes cover images before storage to reduce Arweave costs and sync time.
// Uses Canvas API (supported in all modern browsers).

// The Tarn API hard-caps an encrypted entry blob at 100 KiB
// (MAX_UPLOAD_BYTES); the server returns 413 "Payload too large" above it,
// and BookRepository then keeps the edit pending and retries it forever
// ("could not save to cloud, will retry on next sync"). The cover image is
// base64'd inside that blob and dominates its size, so the cover's base64
// must stay under a budget that leaves headroom for the rest of the record
// (title/author/notes/tags) plus encryption overhead. A FIXED
// dimension+quality encode does NOT guarantee this — a detailed or
// photographic cover at 400×600 (or 600×900 from the crop path) q0.85 can
// blow past it — which is exactly what produced the 413. ~76 KiB of cover
// base64 leaves ~24 KiB for everything else, comfortably under the 100 KiB
// cap for any realistic record.
export const COVER_BASE64_BUDGET_BYTES = 76 * 1024;

// JPEG quality ladder tried (highest first) before falling back to shrinking
// dimensions. Dropping quality preserves resolution/sharpness, so it's the
// preferred lever; dimension shrink is the last resort.
const QUALITY_LADDER = [0.85, 0.72, 0.6, 0.48, 0.38];
// Don't shrink a cover below this on its smaller side — past it the image is
// useless and we accept whatever the smallest encode produced.
const MIN_COVER_DIMENSION = 200;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

function canvasToJpegDataUrl(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error('Canvas toBlob failed')); return; }
        blobToBase64(blob).then(resolve, reject);
      },
      'image/jpeg',
      quality,
    );
  });
}

/** Decode a base64 JPEG payload (no data-URL prefix) into a Blob. */
function base64ToBlob(base64, mime = 'image/jpeg') {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Draw `img` (or a crop of it) into a fresh w×h canvas and JPEG-encode it,
 *  returning the base64 payload (no data-URL prefix). `drawFn(ctx, w, h)`
 *  performs the actual draw. */
async function canvasJpegBase64(width, height, drawFn, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  drawFn(ctx, width, height);
  const dataUrl = await canvasToJpegDataUrl(canvas, quality);
  return dataUrl.split(',')[1] || '';
}

/**
 * Encode under a base64 byte budget. Calls `encode(quality, width, height)`
 * (returns a base64 string) repeatedly: first dropping quality at the start
 * dimensions, then — if min quality still overflows — shrinking ~15% per
 * step down to a floor. Returns the highest-quality encode that fits the
 * budget; if nothing fits (pathological input), returns the smallest encode
 * produced rather than failing the save.
 *
 * Pure orchestration — `encode` does the canvas work — so the budget logic
 * is unit-testable in Node without a real Canvas.
 *
 * @param {(quality:number,width:number,height:number)=>Promise<string>} encode
 * @param {{ startW:number, startH:number, baseQuality?:number,
 *           budgetBytes?:number, floorPx?:number }} opts
 * @returns {Promise<{base64:string, width:number, height:number, quality:number, fits:boolean}>}
 */
export async function encodeUnderBudget(encode, {
  startW,
  startH,
  baseQuality = 0.85,
  budgetBytes = COVER_BASE64_BUDGET_BYTES,
  floorPx = MIN_COVER_DIMENSION,
} = {}) {
  // Quality ladder, capped at the caller's baseQuality (never encode ABOVE
  // the requested quality).
  const ladder = QUALITY_LADDER.filter(q => q <= baseQuality);
  if (ladder.length === 0 || ladder[0] !== baseQuality) ladder.unshift(baseQuality);
  const minQ = ladder[ladder.length - 1];

  let best = null;
  const consider = (base64, width, height, quality) => {
    if (!best || base64.length < best.base64.length) best = { base64, width, height, quality };
  };

  // Pass 1: full dimensions, descending quality. First fit = best quality.
  for (const q of ladder) {
    const base64 = await encode(q, startW, startH);
    consider(base64, startW, startH, q);
    if (base64.length <= budgetBytes) {
      return { base64, width: startW, height: startH, quality: q, fits: true };
    }
  }

  // Pass 2: still over budget at min quality — shrink dimensions and retry.
  let w = startW;
  let h = startH;
  for (let i = 0; i < 6 && Math.min(w, h) > floorPx; i++) {
    w = Math.max(floorPx, Math.round(w * 0.85));
    h = Math.max(floorPx, Math.round(h * 0.85));
    const base64 = await encode(minQ, w, h);
    consider(base64, w, h, minQ);
    if (base64.length <= budgetBytes) {
      return { base64, width: w, height: h, quality: minQ, fits: true };
    }
  }

  // Floor reached: return the smallest encode we produced.
  return { ...best, fits: best.base64.length <= budgetBytes };
}

/**
 * Resize an image blob to fit within maxWidth/maxHeight (preserving aspect
 * ratio, never upscaling) AND keep its base64 under the cover budget so the
 * saved record fits the server's entry cap. Returns the encoded cover.
 *
 * @param {Blob} blob - Original image blob
 * @param {Object} [options]
 * @param {number} [options.maxWidth=400] - Maximum width in pixels
 * @param {number} [options.maxHeight=600] - Maximum height in pixels
 * @param {number} [options.quality=0.85] - Starting JPEG quality 0-1
 * @param {number} [options.budgetBytes] - base64 byte budget (default cover budget)
 * @returns {Promise<{blob: Blob, base64: string, dataUrl: string, mime: string, width: number, height: number, wasResized: boolean}>}
 */
export async function resizeImage(blob, options = {}) {
  const {
    maxWidth = 400,
    maxHeight = 600,
    quality = 0.85,
    budgetBytes = COVER_BASE64_BUDGET_BYTES,
  } = options;

  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;

    // Fit to max dimensions — never upscale.
    const scale = Math.min(maxWidth / srcW, maxHeight / srcH, 1);
    const fitW = Math.round(srcW * scale);
    const fitH = Math.round(srcH * scale);

    const result = await encodeUnderBudget(
      (q, w, h) => canvasJpegBase64(w, h, (ctx) => ctx.drawImage(img, 0, 0, w, h), q),
      { startW: fitW, startH: fitH, baseQuality: quality, budgetBytes },
    );

    const wasResized = scale < 1 || result.width !== fitW || result.quality < quality;
    return {
      blob: base64ToBlob(result.base64),
      base64: result.base64,
      dataUrl: `data:image/jpeg;base64,${result.base64}`,
      mime: 'image/jpeg',
      width: result.width,
      height: result.height,
      wasResized,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Convert blob to base64 data URL.
 * @param {Blob} blob
 * @returns {Promise<string>} data URL (e.g. "data:image/jpeg;base64,...")
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Resize image and return base64 string (without data URL prefix).
 * Main entry point for book_search.js and app.js.
 * Falls back to original if resize fails (never blocks the user).
 *
 * @param {Blob} blob - Original image blob
 * @param {Object} [options] - Same as resizeImage
 * @returns {Promise<{base64: string, mime: string, wasResized: boolean, dataUrl: string}>}
 */
export async function resizeImageToBase64(blob, options = {}) {
  try {
    // resizeImage now produces the budget-fitted base64 + dataUrl directly,
    // so there's no second encode here.
    const { base64, dataUrl, mime, wasResized, width, height } = await resizeImage(blob, options);
    return { base64, mime, wasResized, dataUrl, width, height };
  } catch (err) {
    // Fallback: return original un-resized. This only fires if the canvas
    // path itself failed (rare); the original may still 413, but blocking
    // the user on a transient encode failure is worse.
    console.warn('[Bookish:Image] Resize failed, using original:', err?.message || err);
    const dataUrl = await blobToBase64(blob);
    const base64 = dataUrl.split(',')[1];
    const mime = blob.type || 'image/jpeg';
    return { base64, mime, wasResized: false, dataUrl, width: 0, height: 0 };
  }
}

/**
 * Compute the crop rectangle (in source-image pixel space) that corresponds
 * to a CSS `transform: scale(z) translate(panX, panY)` rendering of an image
 * inside a fixed-aspect tile.
 *
 * The transform is interpreted as the user sees it: a scale-then-translate
 * applied to the image which is initially rendered at the tile's dimensions
 * with `object-fit: contain` (or `cover`, depending on the source). For the
 * Adjust feature, the source is the previously-stored cover image whose
 * natural width/height we can read once it's loaded into an Image element.
 *
 * Why a pure helper: makes the math testable in Node without Canvas — the
 * actual draw step lives in {@link cropAndResizeImageToBase64}.
 *
 * @param {Object} params
 * @param {number} params.srcW - Natural width of the source image (px).
 * @param {number} params.srcH - Natural height of the source image (px).
 * @param {number} params.tileW - Rendered tile width (px).
 * @param {number} params.tileH - Rendered tile height (px).
 * @param {number} params.zoom - Zoom factor (1.0 = no zoom; 3.0 = max).
 * @param {number} params.panX - Pan offset along X axis in *tile* pixels.
 * @param {number} params.panY - Pan offset along Y axis in *tile* pixels.
 * @returns {{ sx:number, sy:number, sw:number, sh:number }} Crop in source pixels.
 */
export function computeCropRect({ srcW, srcH, tileW, tileH, zoom, panX, panY }) {
  // Guard against degenerate inputs — keep the default (no-op) crop.
  const z = Math.max(1, Number(zoom) || 1);
  const tw = Math.max(1, Number(tileW) || 1);
  const th = Math.max(1, Number(tileH) || 1);
  const sw0 = Math.max(1, Number(srcW) || 1);
  const sh0 = Math.max(1, Number(srcH) || 1);
  // Object-fit: contain math — find the rendered image rect inside the tile.
  const fitScale = Math.min(tw / sw0, th / sh0);
  const renderedW = sw0 * fitScale;
  const renderedH = sh0 * fitScale;
  // The visible viewport, in *rendered-image* coordinates, has size (tileW/z, tileH/z)
  // centered around (renderedW/2 - panX/z, renderedH/2 - panY/z).
  const viewportRenderedW = tw / z;
  const viewportRenderedH = th / z;
  const cxRendered = renderedW / 2 - (Number(panX) || 0) / z;
  const cyRendered = renderedH / 2 - (Number(panY) || 0) / z;
  // Convert from rendered-image coords to source-image coords (divide by fitScale).
  // Then clamp to the source-image bounds so we never draw outside it.
  let sw = viewportRenderedW / fitScale;
  let sh = viewportRenderedH / fitScale;
  let sx = (cxRendered - viewportRenderedW / 2) / fitScale;
  let sy = (cyRendered - viewportRenderedH / 2) / fitScale;
  // Letterbox case: viewport may be larger than source on one axis when zoom=1
  // (e.g. portrait source rendered in landscape tile). Clamp without distorting
  // aspect — pull in to source bounds.
  if (sw > sw0) sw = sw0;
  if (sh > sh0) sh = sh0;
  if (sx < 0) sx = 0;
  if (sy < 0) sy = 0;
  if (sx + sw > sw0) sx = sw0 - sw;
  if (sy + sh > sh0) sy = sh0 - sh;
  return { sx, sy, sw, sh };
}

/**
 * Rasterize a transformed cover image into a fixed-size JPEG and return as
 * base64. The transform is described by `{ zoom, panX, panY }` applied to the
 * source image rendered at `{ tileW, tileH }` with `object-fit: contain`.
 *
 * Used by the per-cover Adjust feature on Apply: takes the current pan/zoom
 * preview state and commits a 600×900 (default) cropped JPEG as the new cover.
 *
 * Requires browser Canvas + Image APIs — pure Node will fail (the helper is
 * called only from the browser; the math is exercised separately in
 * {@link computeCropRect} which IS Node-testable).
 *
 * @param {string} srcDataUrl - Source image as a data URL (typically the existing cover).
 * @param {Object} params - Same as {@link computeCropRect} minus srcW/srcH.
 * @param {number} params.tileW
 * @param {number} params.tileH
 * @param {number} params.zoom
 * @param {number} params.panX
 * @param {number} params.panY
 * @param {Object} [options]
 * @param {number} [options.outWidth=600] - Output canvas width.
 * @param {number} [options.outHeight=900] - Output canvas height.
 * @param {number} [options.quality=0.85] - JPEG quality 0-1.
 * @returns {Promise<{ base64: string, mime: string, dataUrl: string, width: number, height: number }>}
 */
export async function cropAndResizeImageToBase64(srcDataUrl, params, options = {}) {
  const { tileW, tileH, zoom, panX, panY } = params;
  const { outWidth = 600, outHeight = 900, quality = 0.85, budgetBytes = COVER_BASE64_BUDGET_BYTES } = options;

  const img = await loadImage(srcDataUrl).catch(() => {
    throw new Error('Failed to load source image for crop');
  });
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const { sx, sy, sw, sh } = computeCropRect({ srcW, srcH, tileW, tileH, zoom, panX, panY });

  // Same crop drawn at the requested output dims; budget-stepping shrinks the
  // OUTPUT canvas (not the crop rect) when needed, preserving the framing.
  // Without this, a 600×900 q0.85 crop of a detailed cover overflows the
  // 100 KiB entry cap and the save 413s ("could not save to cloud").
  const aspect = outHeight / outWidth;
  const result = await encodeUnderBudget(
    (q, w, h) => canvasJpegBase64(w, h, (ctx) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    }, q),
    { startW: outWidth, startH: Math.round(outWidth * aspect), baseQuality: quality, budgetBytes },
  );

  return {
    base64: result.base64,
    mime: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${result.base64}`,
    width: result.width,
    height: result.height,
  };
}
