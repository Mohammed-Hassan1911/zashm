import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, Reorder } from 'framer-motion';
import { Upload, X, GripVertical, AlertCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { getOptimizedImageUrl } from '../../lib/security';

const RAW_DIRECT_LIMIT = 2.9 * 1024 * 1024; // files up to ~2.9MB are sent as-is
const DATAURL_LIMIT = 3.9 * 1024 * 1024;   // server accepts bodies up to 4MB

// استخراج مسار الملف فقط من داخل bucket products (لا شيء خارج البكت يُقبل)
const STORAGE_PATH_RE = /\/storage\/v1\/object\/public\/products\/([A-Za-z0-9._-]+)$/;
function storagePathFromUrl(url) {
  const m = String(url || '').match(STORAGE_PATH_RE);
  return m ? m[1] : null;
}
export { storagePathFromUrl };

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image file'));
    reader.readAsDataURL(file);
  });
}

async function compressImage(dataUrl) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Invalid image file'));
    el.src = dataUrl;
  });
  let { width, height } = img;
  const MAX_DIM = 2000;
  if (width > MAX_DIM || height > MAX_DIM) {
    const scale = Math.min(MAX_DIM / width, MAX_DIM / height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
  let out = canvas.toDataURL('image/webp', 0.85);
  if (out.length > DATAURL_LIMIT || !out.startsWith('data:image/webp')) {
    out = canvas.toDataURL('image/jpeg', 0.8);
  }
  if (out.length > DATAURL_LIMIT) {
    throw new Error('Image too large — please upload a smaller image (max 3MB)');
  }
  return out;
}

export default function ImageUploader({ images = [], onChange, maxImages = 6 }) {
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef();
  const mountedRef = useRef(true);

  // حارس لمنع أي setState أو callback بعد إغلاق/إزالة الـ component (يمنع الكراش بعد Cancel)
  useEffect(() => () => { mountedRef.current = false; }, []);

  // ─── ADD IMAGE URL ─────────────────────────
  const addImage = useCallback((url) => {
    if (!url) return;

    try {
      new URL(url);
    } catch {
      setError('Invalid URL');
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

  // حذف صورة: يحذف ملفها فعليًا من Storage عبر الأدمن API أولًا،
  // وعند النجاح فقط يُزال الـ URL من بيانات المنتج (لا inconsistency عند الفشل).
  const removeImage = async (url) => {
    const path = storagePathFromUrl(url);
    if (path) {
      setDeleting(true);
      setError('');
      try {
        await api.del('/admin/upload', { path });
      } catch (err) {
        console.error('Remove image failed:', err && err.message);
        if (!mountedRef.current) return;
        setError('Could not delete the image. Please try again.');
        setDeleting(false);
        return;
      }
      if (!mountedRef.current) return;
      setDeleting(false);
    }
    if (!mountedRef.current) return;
    onChange(images.filter(i => i !== url));
  };

  const handleUrlAdd = () => {
    addImage(urlInput.trim());
    setUrlInput('');
  };

  // ─── SERVER UPLOAD (storage write happens server-side, never from the browser) ───
  const handleFileUpload = async (files) => {
    setUploading(true);
    setError('');

    try {
      for (const file of Array.from(files)) {
        if (!mountedRef.current) return;

        if (!file.type.startsWith('image/')) {
          setError('Only image files allowed');
          continue;
        }

        if (file.size > 5 * 1024 * 1024) {
          setError('File too large (max 5MB)');
          continue;
        }

        // Compress larger photos locally to stay under the server body limit.
        let dataUrl;
        try {
          const raw = await readAsDataUrl(file);
          dataUrl = raw.length > DATAURL_LIMIT ? await compressImage(raw) : raw;
          if (dataUrl.length > DATAURL_LIMIT) throw new Error('Image too large — please upload a smaller image (max 3MB)');
        } catch (err) {
          if (!mountedRef.current) return;
          setError(err && err.message ? err.message : 'Upload failed');
          continue;
        }

        const payload = await api.post('/admin/upload', { file: dataUrl });
        if (!mountedRef.current) return;
        addImage(payload.url);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      console.error('Upload failed:', err && err.message);
      setError('Upload failed. Please try again.');
    }

    if (mountedRef.current) setUploading(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);

    const files = e.dataTransfer.files;

    if (files.length > 0) {
      handleFileUpload(files);
    }
  };

  return (
    <div>

      {/* DROP ZONE */}
      <motion.div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? 'var(--gold)' : 'var(--border)'}`,
          borderRadius: 6,
          padding: 24,
          textAlign: 'center',
          cursor: 'pointer',
          background: dragging ? 'rgba(201,168,76,0.04)' : 'var(--bg3)',
          marginBottom: 12
        }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*"
          style={{ display: 'none' }}
          onChange={e => handleFileUpload(e.target.files)}
        />

        {uploading ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              width: 20,
              height: 20,
              border: '2px solid var(--gold)',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }} />
            Uploading...
          </div>
        ) : (
          <>
            <Upload size={28} />
            <p>Drag & drop images or click to upload</p>
            <p style={{ fontSize: 11 }}>
              {images.length}/{maxImages} used
            </p>
          </>
        )}
      </motion.div>

      {/* URL INPUT */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
          placeholder="Or paste image URL"
          style={{ flex: 1 }}
        />
        <button onClick={handleUrlAdd}>Add</button>
      </div>

      {/* ERROR */}
      {error && (
        <div style={{ color: 'red', display: 'flex', gap: 6 }}>
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {/* IMAGES */}
      {images.length > 0 && (
        <Reorder.Group
          axis="x"
          values={images}
          onReorder={onChange}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
            gap: 10
          }}
        >
          {images.map((img, idx) => (
            <Reorder.Item key={img} value={img}>
              <div style={{ position: 'relative' }}>

                <img
                  src={getOptimizedImageUrl(img, { width: 200, quality: 70 })}
                  style={{
                    width: '100%',
                    aspectRatio: '3/4',
                    objectFit: 'cover'
                  }}
                />

                {/* COVER */}
                {idx === 0 && (
                  <div style={{
                    position: 'absolute',
                    top: 4,
                    left: 4,
                    background: 'gold',
                    fontSize: 10
                  }}>
                    COVER
                  </div>
                )}

                {/* DELETE */}
                <button
                  type="button"
                  onClick={() => removeImage(img)}
                  disabled={deleting}
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
                    cursor: deleting ? 'wait' : 'pointer',
                    opacity: deleting ? 0.6 : 1,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                    padding: 0,
                    WebkitTapHighlightColor: 'transparent',
                    touchAction: 'manipulation'
                  }}
                >
                  <X size={16} />
                </button>

                <GripVertical
                  size={12}
                  style={{ position: 'absolute', bottom: 4, right: 4 }}
                />
              </div>
            </Reorder.Item>
          ))}
        </Reorder.Group>
      )}
    </div>
  );
}