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

// Defaults tuned for the admin uploader (a product gallery image).
export const RAW_DIRECT_LIMIT = 600 * 1024;
export const MAX_COMPRESSED_SIZE = 900 * 1024;
export const DATAURL_LIMIT = 1.35 * 1024 * 1024;
export const MAX_DIM = 1600;

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

// Compress an image using canvas.toBlob(). Tries quality first, then smaller
// dimensions, so a 12MP phone photo still ends up under the size budget.
export async function compressImage(file, options = {}) {
  const maxDim = Number(options.maxDim) || MAX_DIM;
  const maxSize = Number(options.maxSize) || MAX_COMPRESSED_SIZE;

  const img = await loadImageFromBlob(file);

  const attempts = [
    { maxDim, type: 'image/webp', quality: 0.82 },
    { maxDim, type: 'image/jpeg', quality: 0.78 },
    { maxDim: 1280, type: 'image/jpeg', quality: 0.68 },
    { maxDim: 1024, type: 'image/jpeg', quality: 0.6 },
  ];

  let smallest = null;

  for (const attempt of attempts) {
    const canvas = drawToCanvas(img, attempt.maxDim);

    let blob = await canvasToBlob(canvas, attempt.type, attempt.quality);

    // Fallback if WebP is unsupported.
    if (attempt.type === 'image/webp' && !blob.type.includes('webp')) {
      blob = await canvasToBlob(canvas, 'image/jpeg', 0.78);
    }

    if (!smallest || blob.size < smallest.size) {
      smallest = blob;
    }

    if (blob.size <= maxSize) {
      return blob;
    }
  }

  if (smallest && smallest.size <= maxSize) {
    return smallest;
  }

  throw new Error(
    'Image is too large after compression. Please choose a smaller image.'
  );
}

// Prepare an image before upload: send small files as-is, compress the rest.
export async function prepareImage(file, options = {}) {
  const rawDirectLimit = Number(options.rawDirectLimit) || RAW_DIRECT_LIMIT;
  const dataUrlLimit = Number(options.dataUrlLimit) || DATAURL_LIMIT;
  const maxFileSize = Number(options.maxFileSize) || 0;

  if (maxFileSize && file.size > maxFileSize) {
    throw new Error('Image is too large. Please choose a smaller image.');
  }

  // Send small files directly.
  if (file.size <= rawDirectLimit) {
    const raw = await readAsDataUrl(file);

    if (raw.length <= dataUrlLimit) {
      return raw;
    }
  }

  // Compress large files before Base64 conversion.
  const blob = await compressImage(file, options);

  const dataUrl = await readAsDataUrl(blob);

  if (dataUrl.length > dataUrlLimit) {
    throw new Error('Image exceeds the allowed upload size');
  }

  return dataUrl;
}
