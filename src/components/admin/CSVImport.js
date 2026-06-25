import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, FileText, CheckCircle, AlertCircle, X, Download } from 'lucide-react';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { sanitizeInput } from '../../lib/security';

const REQUIRED_COLUMNS = ['name', 'category', 'price', 'stock'];
const OPTIONAL_COLUMNS = ['salePrice', 'sizes', 'colors', 'label', 'description', 'sku', 'images'];

const SAMPLE_CSV = `name,category,price,salePrice,stock,sizes,colors,label,description,sku
Floral Maxi Dress,Dress,650,520,20,"XS,S,M,L,XL","White,Pink,Blue",New Arrival,Beautiful floral maxi dress,DRS-003
Pearl Necklace Blouse,Top,340,,15,"XS,S,M,L","Ivory,Black",Featured,Elegant blouse with pearl details,TOP-002
Velvet Evening Jacket,Jacket,1100,880,6,"S,M,L","Black,Navy,Emerald",Limited Edition,Luxurious velvet jacket,JKT-002`;

export default function CSVImport({ onClose }) {
  const { importProducts } = useStore();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [errors, setErrors] = useState([]);
  const [importing, setImporting] = useState(false);
  const [success, setSuccess] = useState(false);
  const fileRef = useRef();

  const parseCSV = (file) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const { data, errors: parseErrors } = results;
        const errs = [];

        // Validate columns
        const headers = Object.keys(data[0] || {});
        REQUIRED_COLUMNS.forEach(col => {
          if (!headers.includes(col)) errs.push(`Missing required column: "${col}"`);
        });

        // Validate rows
        const validated = data.map((row, i) => {
          const rowErrors = [];
          if (!row.name?.trim()) rowErrors.push(`Row ${i + 2}: Name is required`);
          if (!row.category?.trim()) rowErrors.push(`Row ${i + 2}: Category is required`);
          if (!row.price || isNaN(+row.price) || +row.price <= 0) rowErrors.push(`Row ${i + 2}: Valid price required`);
          if (row.salePrice && (isNaN(+row.salePrice) || +row.salePrice >= +row.price)) rowErrors.push(`Row ${i + 2}: Sale price must be less than regular price`);
          if (!row.stock || isNaN(+row.stock) || +row.stock < 0) rowErrors.push(`Row ${i + 2}: Valid stock required`);
          errs.push(...rowErrors);

          return {
            name: sanitizeInput(row.name),
            category: sanitizeInput(row.category),
            price: +row.price,
            salePrice: row.salePrice ? +row.salePrice : null,
            stock: +row.stock,
            sizes: row.sizes ? row.sizes.split(',').map(s => s.trim()) : ['S','M','L','XL'],
            colors: row.colors ? row.colors.split(',').map(c => c.trim()) : ['Black','White'],
            label: row.label || 'New Arrival',
            description: sanitizeInput(row.description || ''),
            sku: sanitizeInput(row.sku || ''),
            images: row.images ? row.images.split(',').map(u => u.trim()) : ['https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600'],
          };
        });

        setErrors(errs);
        setPreview(validated);
      },
      error: (err) => setErrors([`Parse error: ${err.message}`]),
    });
  };

  const handleFile = (f) => {
    if (!f) return;
    if (!f.name.endsWith('.csv')) { setErrors(['Please upload a CSV file']); return; }
    setFile(f);
    parseCSV(f);
  };

  const handleImport = async () => {
    if (errors.length > 0 || !preview) return;
    setImporting(true);
    await new Promise(r => setTimeout(r, 600));
    importProducts(preview);
    setImporting(false);
    setSuccess(true);
    setTimeout(() => onClose(), 2000);
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zashm_products_template.csv';
    a.click();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>Bulk Import Products</h2>
        <button onClick={onClose} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
      </div>

      {success ? (
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
          style={{ textAlign: 'center', padding: '40px 0' }}>
          <CheckCircle size={56} color="#27ae60" style={{ margin: '0 auto 16px', display: 'block' }} />
          <p style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: '#27ae60', marginBottom: 8 }}>Import Successful!</p>
          <p style={{ color: 'var(--text2)', fontSize: 13 }}>{preview?.length} products imported</p>
        </motion.div>
      ) : (
        <>
          {/* Download template */}
          <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid var(--border-gold)', borderRadius: 6, padding: '12px 16px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p style={{ color: 'var(--gold)', fontSize: 12, fontWeight: 600, marginBottom: 2 }}>CSV Template</p>
              <p style={{ color: 'var(--text3)', fontSize: 11 }}>Required: name, category, price, stock</p>
            </div>
            <button onClick={downloadSample}
              style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--gold)', background: 'none', border: '1px solid var(--border-gold)', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>
              <Download size={12} /> Template
            </button>
          </div>

          {/* Drop Zone */}
          <div
            style={{ border: `2px dashed ${file ? 'var(--gold)' : 'var(--border)'}`, borderRadius: 6, padding: 32, textAlign: 'center', cursor: 'pointer', background: 'var(--bg3)', marginBottom: 16 }}
            onClick={() => fileRef.current?.click()}
            onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
            onDragOver={e => e.preventDefault()}
          >
            <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
              onChange={e => handleFile(e.target.files[0])} />
            {file ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                <FileText size={20} color="var(--gold)" />
                <span style={{ color: 'var(--gold)', fontSize: 13, fontWeight: 600 }}>{file.name}</span>
              </div>
            ) : (
              <>
                <Upload size={28} color="var(--text3)" style={{ margin: '0 auto 10px', display: 'block' }} />
                <p style={{ color: 'var(--text2)', fontSize: 13 }}>Click or drag your CSV file here</p>
              </>
            )}
          </div>

          {/* Errors */}
          {errors.length > 0 && (
            <div style={{ background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.3)', borderRadius: 6, padding: '12px 16px', marginBottom: 16, maxHeight: 160, overflowY: 'auto' }}>
              {errors.map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <AlertCircle size={12} color="var(--red)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <p style={{ color: 'var(--red)', fontSize: 11 }}>{e}</p>
                </div>
              ))}
            </div>
          )}

          {/* Preview */}
          {preview && errors.length === 0 && (
            <div style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 12, color: 'var(--green)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle size={14} /> {preview.length} products ready to import
              </p>
              <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', maxHeight: 200, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg3)', borderBottom: '1px solid var(--border)' }}>
                      {['Name','Category','Price','Stock','Label'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: 'var(--text3)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.slice(0, 10).map((p, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 10px' }}>{p.name}</td>
                        <td style={{ padding: '6px 10px', color: 'var(--text3)' }}>{p.category}</td>
                        <td style={{ padding: '6px 10px', color: 'var(--gold)' }}>EGP {p.price}</td>
                        <td style={{ padding: '6px 10px' }}>{p.stock}</td>
                        <td style={{ padding: '6px 10px', color: 'var(--text3)' }}>{p.label}</td>
                      </tr>
                    ))}
                    {preview.length > 10 && (
                      <tr><td colSpan={5} style={{ padding: '6px 10px', color: 'var(--text3)', textAlign: 'center' }}>+{preview.length - 10} more rows</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={handleImport}
              disabled={!preview || errors.length > 0 || importing}
              className="gold-btn"
              style={{ flex: 1, opacity: (!preview || errors.length > 0) ? 0.5 : 1 }}
            >
              {importing ? 'Importing...' : `Import ${preview?.length || 0} Products`}
            </button>
            <button className="outline-btn" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
