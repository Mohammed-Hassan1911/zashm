import React, { useState, useRef, useCallback } from 'react';
import { motion, Reorder } from 'framer-motion';
import { Upload, X, GripVertical, AlertCircle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getOptimizedImageUrl } from '../../lib/security';

export default function ImageUploader({ images = [], onChange, maxImages = 6 }) {
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef();

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

  const removeImage = (url) => {
    onChange(images.filter(i => i !== url));
  };

  const handleUrlAdd = () => {
    addImage(urlInput.trim());
    setUrlInput('');
  };

  // ─── SUPABASE UPLOAD FIX ─────────────────────────
  const handleFileUpload = async (files) => {
    setUploading(true);
    setError('');

    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) {
          setError('Only image files allowed');
          continue;
        }

        if (file.size > 5 * 1024 * 1024) {
          setError('File too large (max 5MB)');
          continue;
        }

        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}-${Math.random()
          .toString(36)
          .substring(2)}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from('products')
          .upload(fileName, file);

        if (uploadError) {
          console.error(uploadError);
          setError(uploadError.message);
          continue;
        }

        const { data } = supabase.storage
          .from('products')
          .getPublicUrl(fileName);

        addImage(data.publicUrl);
      }
    } catch (err) {
      console.error(err);
      setError('Upload failed');
    }

    setUploading(false);
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
                  onClick={() => removeImage(img)}
                  style={{
                    position: 'absolute',
                    top: 4,
                    right: 4
                  }}
                >
                  <X size={12} />
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