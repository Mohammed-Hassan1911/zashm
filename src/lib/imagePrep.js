/**
 * Shared client-side image preparation.
 *
 * The admin product uploader and the customer review form both accept a phone
 * photo, so the resize/compress pipeline lives here once: a 12MP JPEG is
 * re-encoded on the device until it fits a small data URL, which keeps the
 * serverless request under Vercel's body limit and the stored file small.
 *
 * Everything is best-effort: if the browser cannot decode the file, the caller
 * gets a readable error instead of a hung upload.
 */

// Defaults tuned for delivery weight, not only for upload success.
//
// Every accepted upload is re-encoded, including small originals. This keeps
// product and customer-submitted images within the same delivery budget.
export const MAX_COMPRESSED_SIZE = 120 * 1024;
export const DATAURL_LIMIT = 1.35 * 1024 * 1024;
export const MAX_DIM = 1000;

// Read a numeric option without treating an explicit zero as a missing value.
function numberOption(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Convert a Blob or File to a data URL.
export function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);

    reader.onerror = () => {
      reject(new Error('Could not read image file'));
    };

    reader.onabort = () => {
      reject(new Error('Image reading was cancelled'));
    };

    reader.readAsDataURL(blob);
  });
}

// Load an image from a Blob without first converting it to Base64.
export function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Invalid or unsupported image'));
    };

    img.src = objectUrl;
  });
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('Image compression failed'));
        return;
      }

      resolve(blob);
    }, type, quality);
  });
}

export function drawToCanvas(img, maxDim) {
  let { width, height } = img;

  if (width > maxDim || height > maxDim) {
    const scale = Math.min(maxDim / width, maxDim / height);

    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement('canvas');

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Image processing is not supported');
  }

  ctx.drawImage(img, 0, 0, width, height);

  return canvas;
}

// Compress an image using canvas.toBlob(). Keep reducing quality and dimensions
// until it fits the delivery budget, so complex images do not fail just because
// a fixed number of compression attempts was insufficient.
export async function compressImage(file, options = {}) {
  const maxDim = Math.max(1, Math.round(numberOption(options.maxDim, MAX_DIM)));
  const maxSize = numberOption(options.maxSize, MAX_COMPRESSED_SIZE);

  const img = await loadImageFromBlob(file);

  let smallest = null;
  let attemptDim = maxDim;

  while (attemptDim >= 1) {
    const canvas = drawToCanvas(img, attemptDim);

    for (const quality of [0.82, 0.68, 0.54, 0.4]) {
      let blob = await canvasToBlob(canvas, 'image/webp', quality);

      // Fall back to JPEG if WebP is not supported by this browser.
      if (!blob.type.includes('webp')) {
        blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      }

      if (!smallest || blob.size < smallest.size) smallest = blob;
      if (blob.size <= maxSize) return blob;
    }

    if (attemptDim === 1) break;
    attemptDim = Math.max(1, Math.floor(attemptDim * 0.8));
  }

  if (smallest && smallest.size <= maxSize) {
    return smallest;
  }

  throw new Error(
    'Image is too large after compression. Please choose a smaller image.'
  );
}

// Prepare every accepted image for upload; no original is sent through raw.
export async function prepareImage(file, options = {}) {
  const dataUrlLimit = numberOption(options.dataUrlLimit, DATAURL_LIMIT);
  const maxFileSize = numberOption(options.maxFileSize, 0);

  if (maxFileSize && file.size > maxFileSize) {
    throw new Error('Image is too large. Please choose a smaller image.');
  }

  // Re-encode small and large accepted files alike before Base64 conversion.
  const blob = await compressImage(file, options);

  const dataUrl = await readAsDataUrl(blob);

  if (dataUrl.length > dataUrlLimit) {
    throw new Error('Image exceeds the allowed upload size');
  }

  return dataUrl;
}
