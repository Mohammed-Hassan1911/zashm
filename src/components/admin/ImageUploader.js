import React, {
  useState,
  useRef,
  useCallback,
  useEffect
} from 'react';

import { motion } from 'framer-motion';
import { Upload, X, AlertCircle } from 'lucide-react';

import { api, deleteStorageFile } from '../../lib/api';
import { getOptimizedImageUrl } from '../../lib/security';
import { supabase } from '../../lib/supabase';

const RAW_DIRECT_LIMIT = 600 * 1024;
const MAX_COMPRESSED_SIZE = 900 * 1024;
const DATAURL_LIMIT = 1.35 * 1024 * 1024;

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_DIM = 1600;
// One at a time: two parallel 3MB bodies saturate a mobile uplink and make
// both requests more likely to drop (which surfaces as a network error).
const MAX_PARALLEL_UPLOADS = 1;
const UPLOAD_TIMEOUT = 90000;
const UPLOAD_RETRIES = 1;
const RETRY_DELAY_MS = 1500;

// A failed fetch has status 0 in ApiError; 408/5xx are worth one more attempt.
function isRetryableUploadError(err) {
  const status = Number(err?.status ?? 0);
  return status === 0 || status === 408 || status === 502 || status === 503 || status === 504;
}

// Extract a safe path from products bucket URLs only.
function storagePathFromUrl(url) {
  let parsed;

  try {
    parsed = new URL(String(url || ''));
  } catch {
    return null;
  }

  let configuredOrigin;

  try {
    configuredOrigin = new URL(supabase.supabaseUrl).origin;
  } catch {
    return null;
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== configuredOrigin
  ) {
    return null;
  }

  const match = parsed.pathname.match(
    /^\/storage\/v1\/object\/public\/products\/(.+)$/
  );

  if (!match) return null;

  try {
    const path = decodeURIComponent(match[1]);
    const segments = path.split('/');

    if (
      path.length > 512 ||
      segments.some(segment =>
        !/^[A-Za-z0-9._ -]{1,120}$/.test(segment) ||
        segment === '.' ||
        segment === '..'
      ) ||
      !/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(path)
    ) {
      return null;
    }

    return path;
  } catch {
    return null;
  }
}

export { storagePathFromUrl };

// Convert Blob or File to Data URL.
function readAsDataUrl(blob) {
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
function loadImageFromBlob(blob) {
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

function canvasToBlob(canvas, type, quality) {
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

function drawToCanvas(img, maxDim) {
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
// dimensions, so a 12MP phone photo still ends up under MAX_COMPRESSED_SIZE.
async function compressImage(file) {
  const img = await loadImageFromBlob(file);

  const attempts = [
    { maxDim: MAX_DIM, type: 'image/webp', quality: 0.82 },
    { maxDim: MAX_DIM, type: 'image/jpeg', quality: 0.78 },
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

    if (blob.size <= MAX_COMPRESSED_SIZE) {
      return blob;
    }
  }

  if (smallest && smallest.size <= MAX_COMPRESSED_SIZE) {
    return smallest;
  }

  throw new Error(
    'Image is too large after compression. Please choose a smaller image.'
  );
}

// Prepare image before upload.
async function prepareImage(file) {
  // Send small files directly.
  if (file.size <= RAW_DIRECT_LIMIT) {
    const raw = await readAsDataUrl(file);

    if (raw.length <= DATAURL_LIMIT) {
      return raw;
    }
  }

  // Compress large files before Base64 conversion.
  const blob = await compressImage(file);

  const dataUrl = await readAsDataUrl(blob);

  if (dataUrl.length > DATAURL_LIMIT) {
    throw new Error('Image exceeds the allowed upload size');
  }

  return dataUrl;
}

// Convert errors to readable messages.
function getUploadError(err) {
  const status = Number(
    err?.status ??
    err?.response?.status ??
    err?.payload?.status ??
    0
  );

  if (status === 408) {
    return 'Upload timed out. Please try again.';
  }

  if (status === 413) {
    return 'Image is too large for the server. Please choose a smaller image.';
  }

  if (status === 401) {
    return 'Your session has expired. Please login again.';
  }

  if (status === 403) {
    return 'You do not have permission to upload images.';
  }

  if (status === 429) {
    return 'Too many upload requests. Please wait and try again.';
  }

  if (status >= 500) {
    return 'Server error while uploading. Please try again later.';
  }

  if (status === 0 && err?.message) {
    return err.message;
  }

  return err?.message || 'Upload failed. Please try again.';
}

export default function ImageUploader({
  images = [],
  onChange,
  maxImages = 6
}) {
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [isTouchDragging, setIsTouchDragging] = useState(false);

  const fileRef = useRef(null);
  const mountedRef = useRef(false);
  const touchDragIndex = useRef(null);
  const uploadLockRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Add external image URL.
  const addImage = useCallback((url) => {
    if (uploadLockRef.current) return;
    if (!url) return;

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      setError('Invalid URL');
      return;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      setError('Only HTTP and HTTPS image URLs are allowed');
      return;
    }

    if (images.includes(url)) {
      setError('Image already added');
      return;
    }

    if (images.length >= maxImages) {
      setError(`Maximum ${maxImages} images allowed`);
      return;
    }

    onChange([...images, url]);
    setError('');
  }, [images, onChange, maxImages]);

  // Remove image from form only.
  const removeImage = useCallback((url) => {
    if (!mountedRef.current || uploadLockRef.current) return;

    onChange(images.filter(image => image !== url));
  }, [images, onChange]);

  // Reorder images.
  const reorderImages = useCallback((fromIndex, toIndex) => {
    if (uploadLockRef.current) return;

    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= images.length ||
      toIndex >= images.length
    ) {
      return;
    }

    const next = [...images];
    const [moved] = next.splice(fromIndex, 1);

    next.splice(toIndex, 0, moved);

    onChange(next);
  }, [images, onChange]);

  // URL input.
  const handleUrlAdd = () => {
    if (uploadLockRef.current) return;

    addImage(urlInput.trim());
    setUrlInput('');
  };

  // Upload a single file, retrying once on a dropped connection / cold 5xx.
  const uploadSingleFile = async (file) => {
    const dataUrl = await prepareImage(file);

    let lastError = null;

    for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt += 1) {
      try {
        const payload = await api.post(
          '/admin/upload',
          { file: dataUrl },
          { timeoutMs: UPLOAD_TIMEOUT }
        );

        if (!payload?.url || !payload?.path) {
          throw new Error('Server did not return a valid image URL and path');
        }

        return payload;
      } catch (err) {
        lastError = err;

        const canRetry =
          attempt < UPLOAD_RETRIES &&
          isRetryableUploadError(err) &&
          mountedRef.current;

        if (!canRetry) throw err;

        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }

    throw lastError;
  };

  // Clean up uploaded image if editor was closed.
  const cleanupCancelledUpload = (payload) => {
    if (!payload?.path) return;

    deleteStorageFile(payload.path).catch(err => {
      console.error(
        'Post-cancel upload cleanup failed:',
        err?.message
      );
    });
  };

  // Upload selected files.
  const handleFileUpload = async (files) => {
    if (uploadLockRef.current) return;

    const selectedFiles = Array.from(files || []);

    if (!selectedFiles.length) return;

    uploadLockRef.current = true;

    setUploading(true);
    setError('');

    const validFiles = [];
    let failureCount = 0;
    let errorMessage = '';

    // Reserve available image slots.
    const availableSlots = Math.max(
      0,
      maxImages - images.length
    );

    // Validate selected files.
    for (const file of selectedFiles) {
      if (!file.type.startsWith('image/')) {
        failureCount++;
        errorMessage = 'Only image files are allowed';
        continue;
      }

      if (file.size > MAX_FILE_SIZE) {
        failureCount++;
        errorMessage = 'File too large (maximum 15MB)';
        continue;
      }

      if (validFiles.length >= availableSlots) {
        errorMessage = `Maximum ${maxImages} images allowed`;
        break;
      }

      validFiles.push(file);
    }

    if (!validFiles.length) {
      uploadLockRef.current = false;

      if (mountedRef.current) {
        setUploading(false);
        setError(
          errorMessage || `Maximum ${maxImages} images allowed`
        );

        if (fileRef.current) {
          fileRef.current.value = '';
        }
      }

      return;
    }

    // Store results by original file index.
    // This preserves the user's selected order.
    const uploadedResults = new Array(validFiles.length);

    setProgress({ done: 0, total: validFiles.length });

    let currentIndex = 0;
    let successCount = 0;

    const worker = async () => {
      while (true) {
        if (!mountedRef.current) return;

        const index = currentIndex++;

        if (index >= validFiles.length) return;

        const file = validFiles[index];

        try {
          const payload = await uploadSingleFile(file);

          // Editor closed during upload.
          if (!mountedRef.current) {
            cleanupCancelledUpload(payload);
            return;
          }

          uploadedResults[index] = payload.url;
          successCount++;

        } catch (err) {
          failureCount++;

          console.error('Individual image upload failed:', {
            name: file.name,
            size: file.size,
            type: file.type,
            message: err?.message,
            status: err?.status,
            payload: err?.payload
          });

          errorMessage = getUploadError(err);
        } finally {
          if (mountedRef.current) {
            setProgress(prev => ({ ...prev, done: prev.done + 1 }));
          }
        }
      }
    };

    try {
      const workers = Array.from(
        {
          length: Math.min(
            MAX_PARALLEL_UPLOADS,
            validFiles.length
          )
        },
        () => worker()
      );

      await Promise.all(workers);

      if (!mountedRef.current) return;

      // Append successful images in selection order.
      if (successCount > 0) {
        const merged = [...images];

        for (const url of uploadedResults) {
          if (url && !merged.includes(url)) {
            merged.push(url);
          }
        }

        onChange(merged);
      }

      if (failureCount > 0) {
        setError(
          successCount > 0
            ? `${successCount} image(s) uploaded, ${failureCount} failed. ${errorMessage}`
            : errorMessage || 'Upload failed. Please try again.'
        );
      } else {
        setError('');
      }

    } catch (err) {
      if (!mountedRef.current) return;

      console.error('Upload process failed:', err);

      setError(getUploadError(err));

    } finally {
      uploadLockRef.current = false;

      if (mountedRef.current) {
        setUploading(false);
        setProgress({ done: 0, total: 0 });

        if (fileRef.current) {
          fileRef.current.value = '';
        }
      }
    }
  };

  // Drop zone.
  const handleDrop = (e) => {
    e.preventDefault();

    setDragging(false);

    if (uploadLockRef.current) return;

    if (e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files);
    }
  };

  return (
    <div>

      {/* DROP ZONE */}

      <motion.div
        onDragOver={e => {
          e.preventDefault();

          if (!uploadLockRef.current) {
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        role="button"
        tabIndex={0}
        aria-label="Upload product images"
        aria-disabled={uploading}
        onClick={() => {
          if (!uploading) {
            fileRef.current?.click();
          }
        }}
        onKeyDown={e => {
          if (
            !uploading &&
            (e.key === 'Enter' || e.key === ' ')
          ) {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
        style={{
          border: `2px dashed ${
            dragging ? 'var(--gold)' : 'var(--border)'
          }`,
          borderRadius: 6,
          padding: 24,
          textAlign: 'center',
          cursor: uploading ? 'wait' : 'pointer',
          background: dragging
            ? 'rgba(201,168,76,0.04)'
            : 'var(--bg3)',
          marginBottom: 12,
          opacity: uploading ? 0.7 : 1
        }}
      >

        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*"
          aria-label="Product image file input"
          style={{ display: 'none' }}
          disabled={uploading}
          onChange={e => handleFileUpload(e.target.files)}
        />

        {uploading ? (
          <div style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <div style={{
              width: 20,
              height: 20,
              border: '2px solid var(--gold)',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }} />

            {progress.total > 0
              ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}...`
              : 'Uploading images...'}
          </div>
        ) : (
          <>
            <Upload size={28} />

            <p>
              Drag & drop images or click to upload
            </p>

            <p style={{ fontSize: 11 }}>
              {images.length}/{maxImages} used
            </p>

            <p style={{ fontSize: 11, opacity: 0.65 }}>
              Up to 15MB per image — resized automatically
            </p>
          </>
        )}
      </motion.div>

      {/* URL INPUT */}

      <div style={{
        display: 'flex',
        gap: 8,
        marginBottom: 14
      }}>
        <input
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleUrlAdd();
            }
          }}
          placeholder="Or paste image URL"
          style={{ flex: 1 }}
          disabled={uploading}
        />

        <button
          type="button"
          onClick={handleUrlAdd}
          disabled={!urlInput.trim() || uploading}
        >
          Add
        </button>
      </div>

      {/* ERROR */}

      {error && (
        <div
          role="alert"
          style={{
            color: 'red',
            display: 'flex',
            gap: 6,
            alignItems: 'flex-start',
            marginBottom: 12,
            fontSize: 13
          }}
        >
          <AlertCircle size={14} />

          <span>{error}</span>
        </div>
      )}

      {/* IMAGES */}

      {images.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
          gap: 10
        }}>

          {images.map((img, idx) => (
            <div
              key={img}
              draggable={!uploading}
              data-img-tile
              data-img-tile-index={idx}

              onDragStart={e => {
                if (uploading) {
                  e.preventDefault();
                  return;
                }

                setDraggedIndex(idx);

                e.dataTransfer.effectAllowed = 'move';

                try {
                  e.dataTransfer.setData(
                    'text/plain',
                    String(idx)
                  );
                } catch {}
              }}

              onDragOver={e => {
                if (uploading) return;

                e.preventDefault();

                e.dataTransfer.dropEffect = 'move';

                if (dragOverIndex !== idx) {
                  setDragOverIndex(idx);
                }
              }}

              onDragEnter={e => {
                if (uploading) return;

                e.preventDefault();
                setDragOverIndex(idx);
              }}

              onDrop={e => {
                e.preventDefault();

                if (uploading) return;

                const fromIdx =
                  draggedIndex !== null
                    ? draggedIndex
                    : Number(
                        e.dataTransfer.getData('text/plain')
                      );

                if (Number.isFinite(fromIdx)) {
                  reorderImages(fromIdx, idx);
                }

                setDraggedIndex(null);
                setDragOverIndex(null);
              }}

              onDragEnd={() => {
                setDraggedIndex(null);
                setDragOverIndex(null);
              }}

              onTouchStart={() => {
                if (uploading) return;

                touchDragIndex.current = idx;

                setIsTouchDragging(true);
                setDraggedIndex(idx);
              }}

              onTouchMove={e => {
                if (
                  uploading ||
                  touchDragIndex.current === null
                ) {
                  return;
                }

                const touch = e.touches[0];

                const target = document.elementFromPoint(
                  touch.clientX,
                  touch.clientY
                );

                const tile = target?.closest('[data-img-tile]');

                if (tile) {
                  const overIdx = Number(
                    tile.dataset.imgTileIndex
                  );

                  if (
                    !Number.isNaN(overIdx) &&
                    overIdx !== dragOverIndex
                  ) {
                    setDragOverIndex(overIdx);
                  }
                }
              }}

              onTouchEnd={() => {
                if (
                  !uploading &&
                  touchDragIndex.current !== null &&
                  dragOverIndex !== null &&
                  dragOverIndex !== touchDragIndex.current
                ) {
                  reorderImages(
                    touchDragIndex.current,
                    dragOverIndex
                  );
                }

                touchDragIndex.current = null;

                setIsTouchDragging(false);
                setDraggedIndex(null);
                setDragOverIndex(null);
              }}

              style={{
                cursor: uploading ? 'default' : 'grab',
                transition:
                  'transform 150ms ease, opacity 150ms ease, box-shadow 150ms ease',

                transform:
                  draggedIndex === idx
                    ? 'scale(0.98)'
                    : dragOverIndex === idx &&
                      draggedIndex !== null &&
                      draggedIndex !== idx
                      ? 'translateY(4px)'
                      : 'none',

                opacity:
                  draggedIndex === idx ? 0.7 : 1,

                boxShadow:
                  dragOverIndex === idx &&
                  draggedIndex !== null &&
                  draggedIndex !== idx
                    ? '0 4px 12px rgba(201,168,76,0.25)'
                    : 'none',

                touchAction: isTouchDragging
                  ? 'none'
                  : 'pan-y'
              }}
            >

              <div style={{ position: 'relative' }}>

                <img
                  src={getOptimizedImageUrl(img, {
                    width: 200,
                    quality: 70
                  })}
                  alt={`Product image ${idx + 1}`}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  style={{
                    width: '100%',
                    aspectRatio: '3/4',
                    objectFit: 'cover',
                    userSelect: 'none',
                    pointerEvents: 'none'
                  }}
                />

                {/* COVER */}

                {idx === 0 && (
                  <div style={{
                    position: 'absolute',
                    top: 4,
                    left: 4,
                    background: 'gold',
                    fontSize: 10,
                    padding: '2px 4px'
                  }}>
                    COVER
                  </div>
                )}

                {/* DELETE */}

                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    removeImage(img);
                  }}
                  disabled={uploading}
                  aria-label={`Delete image ${idx + 1}`}
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    zIndex: 10,
                    width: 32,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(0,0,0,0.6)',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.35)',
                    borderRadius: 6,
                    cursor: uploading ? 'not-allowed' : 'pointer',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                    padding: 0,
                    WebkitTapHighlightColor: 'transparent',
                    touchAction: 'manipulation',
                    opacity: uploading ? 0.5 : 1
                  }}
                >
                  <X size={16} />
                </button>

              </div>
            </div>
          ))}

        </div>
      )}

    </div>
  );
}