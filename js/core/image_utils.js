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
    const { blob: resizedBlob, wasResized } = await resizeImage(blob, options);
    const dataUrl = await blobToBase64(resizedBlob);
    const base64 = dataUrl.split(',')[1];
    const mime = resizedBlob.type || 'image/jpeg';
    return { base64, mime, wasResized, dataUrl };
  } catch (err) {
    // Fallback: return original un-resized
    console.warn('[Bookish:Image] Resize failed, using original:', err?.message || err);
    const dataUrl = await blobToBase64(blob);
    const base64 = dataUrl.split(',')[1];
    const mime = blob.type || 'image/jpeg';
    return { base64, mime, wasResized: false, dataUrl };
  }
}
