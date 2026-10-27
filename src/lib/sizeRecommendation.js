// ─── SMART SIZE RECOMMENDATION UTILITY ──────────────────────────────────────
// Product-specific size recommendations based on height/weight
// Never invents missing data, never recommends unavailable sizes

/**
 * Check if a specific size is available (has stock in at least one color)
 * @param {Object} product 
 * @param {string} size 
 * @param {string|null} selectedColor - if provided, check only this color
 * @returns {boolean}
 */
export function isSizeAvailable(product, size, selectedColor = null) {
  if (!product || !size) return false;
  
  const variantStock = product.variantStock;
  const colors = product.colors || [];
  
  // If variantStock exists and has data
  if (variantStock && typeof variantStock === 'object' && !Array.isArray(variantStock) && Object.keys(variantStock).length > 0) {
    if (selectedColor) {
      // Check specific color
      const key = `${size}-${selectedColor}`;
      return (Number(variantStock[key]) || 0) > 0;
    }
    // Check if any color has stock
    if (colors.length === 0) return false;
    for (const color of colors) {
      const key = `${size}-${color}`;
      if ((Number(variantStock[key]) || 0) > 0) {
        return true;
      }
    }
    return false;
  }
  
  // Legacy fallback to global stock
  const globalStock = Number(product.stock || 0);
  return globalStock > 0;
}

/**
 * Get available sizes for a product
 * @param {Object} product 
 * @param {string|null} selectedColor 
 * @returns {string[]}
 */
export function getAvailableSizes(product, selectedColor = null) {
  const sizes = product?.sizes || [];
  return sizes.filter(size => isSizeAvailable(product, size, selectedColor));
}

/**
 * Recommend size based on height, weight, and product configuration
 * @param {Object} product 
 * @param {Object} userInput - { height: number (cm), weight: number (kg), fit?: 'slim'|'regular'|'oversized', color?: string }
 * @returns {Object} recommendation result
 */
export function recommendSize(product, userInput) {
  const { height, weight, fit = 'regular', color = null } = userInput || {};
  
  if (!product) {
    return { 
      success: false, 
      reason: 'no_product', 
      message: 'Product information not available.' 
    };
  }
  
  // Validate user input
  const h = Number(height);
  const w = Number(weight);
  
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) {
    return { 
      success: false, 
      reason: 'invalid_input', 
      message: 'Please enter valid height and weight values.' 
    };
  }
  
  // Reasonable sanity checks
  if (h < 120 || h > 250 || w < 30 || w > 200) {
    return { 
      success: false, 
      reason: 'invalid_input', 
      message: 'Please enter reasonable height (cm) and weight (kg) values.' 
    };
  }
  
  const sizes = product.sizes || [];
  const recommendations = product.sizeRecommendations || {};
  
  // Get available sizes (respecting selected color if provided)
  const availableSizes = getAvailableSizes(product, color);
  
  if (availableSizes.length === 0) {
    return { 
      success: false, 
      reason: 'no_stock', 
      message: 'No sizes are available for this product with the current selection.' 
    };
  }
  
  // Find sizes that have recommendation data AND are available
  const candidatesWithData = availableSizes.filter(size => {
    const rec = recommendations[size];
    return rec && 
           typeof rec.heightMin === 'number' && typeof rec.heightMax === 'number' &&
           typeof rec.weightMin === 'number' && typeof rec.weightMax === 'number' &&
           rec.heightMin <= rec.heightMax && rec.weightMin <= rec.weightMax;
  });
  
  if (candidatesWithData.length === 0) {
    return { 
      success: false, 
      reason: 'no_data', 
      message: 'Size recommendations are not configured for this product. Please use the size guide.',
      showSizeGuide: true
    };
  }
  
  // Score each candidate
  // Perfect match = both height and weight in range
  // Tie-breaking: prefer perfect matches, then if multiple perfect matches pick based on fit preference or first
  const matches = [];
  
  for (const size of candidatesWithData) {
    const rec = recommendations[size];
    const heightOk = h >= rec.heightMin && h <= rec.heightMax;
    const weightOk = w >= rec.weightMin && w <= rec.weightMax;
    
    if (heightOk && weightOk) {
      matches.push({ 
        size, 
        perfect: true, 
        score: 100,
        heightOk: true,
        weightOk: true
      });
    }
    // We do NOT count partial matches as reliable recommendations per requirements
    // "do not present a partial match as a high-confidence recommendation"
  }
  
  if (matches.length === 0) {
    return { 
      success: false, 
      reason: 'out_of_range', 
      message: 'Your measurements fall outside the configured ranges for available sizes. A confident recommendation cannot be made. Please check the size guide.',
      showSizeGuide: true
    };
  }
  
  // If multiple sizes match perfectly, we cannot reliably distinguish - return ambiguous result
  if (matches.length > 1) {
    // Sort by position in product.sizes array for consistent display
    const sortedMatches = [...matches].sort((a, b) => {
      const idxA = sizes.indexOf(a.size);
      const idxB = sizes.indexOf(b.size);
      if (idxA !== idxB) return idxA - idxB;
      return 0;
    });
    const matchingSizes = sortedMatches.map(m => m.size);
    return {
      success: false,
      reason: 'ambiguous',
      message: 'Multiple sizes match your measurements. We cannot reliably distinguish between them. Please check the size guide or select based on your preference.',
      matchingSizes,
      alternatives: matchingSizes,
      showSizeGuide: true
    };
  }
  
  // Exactly one match
  const recommended = matches[0].size;
  return { 
    success: true, 
    size: recommended, 
    confidence: 'high',
    alternatives: [],
    message: `Based on your measurements, we recommend size ${recommended}.`
  };
}

/**
 * Format recommendation data for storage
 * Converts form data to the structure we need
 */
export function formatRecommendationsForStorage(sizes, recData) {
  const result = {};
  if (!Array.isArray(sizes)) return result;
  
  for (const size of sizes) {
    const data = recData[size];
    if (!data) continue;
    
    const hMin = Number(data.heightMin);
    const hMax = Number(data.heightMax);
    const wMin = Number(data.weightMin);
    const wMax = Number(data.weightMax);
    
    // Only save if all values are valid numbers and min <= max
    if (Number.isFinite(hMin) && Number.isFinite(hMax) && 
        Number.isFinite(wMin) && Number.isFinite(wMax) &&
        hMin <= hMax && wMin <= wMax &&
        hMin >= 0 && wMin >= 0) {
      result[size] = {
        heightMin: hMin,
        heightMax: hMax,
        weightMin: wMin,
        weightMax: wMax
      };
    }
  }
  
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse recommendations from storage for form display
 */
export function parseRecommendationsForForm(sizes, sizeRecommendations) {
  const result = {};
  if (!Array.isArray(sizes) || !sizeRecommendations || typeof sizeRecommendations !== 'object') {
    return result;
  }
  
  for (const size of sizes) {
    const rec = sizeRecommendations[size];
    if (rec && typeof rec === 'object') {
      result[size] = {
        heightMin: rec.heightMin ?? '',
        heightMax: rec.heightMax ?? '',
        weightMin: rec.weightMin ?? '',
        weightMax: rec.weightMax ?? ''
      };
    } else {
      result[size] = {
        heightMin: '',
        heightMax: '',
        weightMin: '',
        weightMax: ''
      };
    }
  }
  
  return result;
}
