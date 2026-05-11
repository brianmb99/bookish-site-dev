// image_utils.js - Image processing utilities for cover downsampling
// Resizes cover images before storage to reduce Arweave costs and sync time.
// Uses Canvas API (supported in all modern browsers).

/**
 * Resize an image blob to fit within maxDimension, preserving aspect ratio.
 * Returns a new blob as JPEG with specified quality.
 * Never upscales — if the image already fits, returns it as-is.
 *
 * @param {Blob} blob - Original image blob
 * @param {Object} [options]
 * @param {number} [options.maxWidth=400] - Maximum width in pixels
 * @param {number} [options.maxHeight=600] - Maximum height in pixels
 * @param {number} [options.quality=0.85] - JPEG quality 0-1
 * @returns {Promise<{blob: Blob, width: number, height: number, wasResized: boolean}>}
 */
export async function resizeImage(blob, options = {}) {
  const {
    maxWidth = 400,
    maxHeight = 600,
    quality = 0.85,
  } = options;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;
      let wasResized = false;

      // Calculate scale factor — never upscale
      const scaleW = maxWidth / width;
      const scaleH = maxHeight / height;
      const scale = Math.min(scaleW, scaleH, 1);

      if (scale < 1) {
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        wasResized = true;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (resizedBlob) => {
          if (resizedBlob) {
            resolve({ blob: resizedBlob, width, height, wasResized });
          } else {
            reject(new Error('Canvas toBlob failed'));
          }
        },
        'image/jpeg',
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
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
    const { blob: resizedBlob, width, height, wasResized } = await resizeImage(blob, options);
    const dataUrl = await blobToBase64(resizedBlob);
    const base64 = dataUrl.split(',')[1];
    const mime = resizedBlob.type || 'image/jpeg';
    return { base64, mime, wasResized, dataUrl, width, height };
  } catch (err) {
    // Fallback: return original un-resized
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
  const { outWidth = 600, outHeight = 900, quality = 0.85 } = options;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const srcW = img.naturalWidth || img.width;
      const srcH = img.naturalHeight || img.height;
      const { sx, sy, sw, sh } = computeCropRect({ srcW, srcH, tileW, tileH, zoom, panX, panY });
      const canvas = document.createElement('canvas');
      canvas.width = outWidth;
      canvas.height = outHeight;
      const ctx = canvas.getContext('2d');
      // Fill with black first so any letterbox shows as a clean band (very rare
      // edge case — the clamp in computeCropRect prevents this for zoom >= 1).
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outWidth, outHeight);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outWidth, outHeight);
      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error('Canvas toBlob failed')); return; }
          blobToBase64(blob).then((dataUrl) => {
            const base64 = dataUrl.split(',')[1];
            resolve({ base64, mime: 'image/jpeg', dataUrl, width: outWidth, height: outHeight });
          }).catch(reject);
        },
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Failed to load source image for crop'));
    img.src = srcDataUrl;
  });
}
