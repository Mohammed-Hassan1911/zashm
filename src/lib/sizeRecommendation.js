// ─── SMART SIZE RECOMMENDATION UTILITY ──────────────────────────────────────
// Product-specific size recommendations based on height/weight
// Never invents missing data, never recommends unavailable sizes

const MESSAGES = {
  ar: {
    invalid_input: 'يرجى إدخال قيم صحيحة للطول والوزن.',
    sanity_range: 'يرجى إدخال قيم معقولة للطول (سم) والوزن (كجم).',
    no_product: 'معلومات المنتج غير متاحة.',
    no_stock: 'لا توجد مقاسات متاحة لهذا المنتج بالاختيار الحالي.',
    no_data: 'لم يتم إعداد توصيات المقاسات لهذا المنتج. يرجى استخدام دليل المقاسات.',
    no_data_suffix: 'يرجى استخدام دليل المقاسات.',
    recommended_direct: (size) => `مقاسك المناسب هو ${size} 🎯`,
    recommended_direct_with_unavailable: (size) => `مقاسك المناسب هو ${size} 🎯\nللأسف، المقاس ${size} غير متوفر حاليًا. تابعنا لمعرفة موعد توفره مرة تانية.`,
    closest: (size) => `أقرب مقاس لبياناتك هو ${size}. يُرجى مراجعة دليل المقاسات للتأكد.`,
    out_of_range: 'بياناتك خارج نطاق المقاسات المتاحة. يُرجى مراجعة دليل المقاسات لاختيار الأنسب.',
    ambiguous: 'تطابق قياساتك مع أكثر من مقاس. لا يمكن التمييز بينهم بشكل دقيق. يرجى مراجعة دليل المقاسات أو الاختيار حسب تفضيلك.',
    try_again: 'حاول مرة أخرى'
  },
  en: {
    invalid_input: 'Please enter valid height and weight values.',
    sanity_range: 'Please enter reasonable height (cm) and weight (kg) values.',
    no_product: 'Product information not available.',
    no_stock: 'No sizes are available for this product with the current selection.',
    no_data: 'Size recommendations are not configured for this product. Please use the size guide.',
    no_data_suffix: 'Please use the size guide.',
    recommended_direct: (size) => `Your recommended size is ${size} 🎯`,
    recommended_direct_with_unavailable: (size) => `Your recommended size is ${size} 🎯\nUnfortunately, size ${size} is currently unavailable. Check back for availability updates.`,
    closest: (size) => `The closest size to your measurements is ${size}. Please check the size guide to confirm.`,
    out_of_range: 'Your measurements fall outside the available size ranges. Please check the size guide to find the best fit.',
    ambiguous: 'Multiple sizes match your measurements. We cannot reliably distinguish between them. Please check the size guide or select based on your preference.',
    try_again: 'Try Again'
  }
};

function getLang(userInput) {
  const lang = userInput?.lang || userInput?.language;
  if (lang === 'ar' || lang === 'arabic') return 'ar';
  if (lang === 'en' || lang === 'english') return 'en';
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('zashm_lang');
    if (stored === 'ar' || stored === 'en') return stored;
  }
  return 'en';
}

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
 * @param {Object} userInput - { height: number (cm), weight: number (kg), fit?: 'slim'|'regular'|'oversized', color?: string, lang?: 'ar'|'en' }
 * @returns {Object} recommendation result
 */
export function recommendSize(product, userInput) {
  const { height, weight, fit = 'regular', color = null } = userInput || {};
  const lang = getLang(userInput);
  const t = MESSAGES[lang];
  
  if (!product) {
    return { 
      success: false, 
      reason: 'no_product', 
      message: t.no_product 
    };
  }
  
  // Validate user input
  const h = Number(height);
  const w = Number(weight);
  
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) {
    return { 
      success: false, 
      reason: 'invalid_input', 
      message: t.invalid_input 
    };
  }
  
  // Reasonable sanity checks
  if (h < 120 || h > 250 || w < 30 || w > 200) {
    return { 
      success: false, 
      reason: 'invalid_input', 
      message: t.sanity_range 
    };
  }
  
  const sizes = product.sizes || [];
  const recommendations = product.sizeRecommendations || {};
  
  // Find sizes that have recommendation data (check all sizes with data, not just available ones)
  const candidatesWithData = sizes.filter(size => {
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
      message: t.no_data,
      showSizeGuide: true
    };
  }
  
  // Sort by position in product.sizes array for consistent display
  const sortBySizeOrder = (a, b) => {
    const idxA = sizes.indexOf(a.size);
    const idxB = sizes.indexOf(b.size);
    if (idxA !== idxB) return idxA - idxB;
    return 0;
  };
  
  // Score each candidate for perfect match (both height and weight in range)
  const perfectMatches = [];
  
  for (const size of candidatesWithData) {
    const rec = recommendations[size];
    const heightOk = h >= rec.heightMin && h <= rec.heightMax;
    const weightOk = w >= rec.weightMin && w <= rec.weightMax;
    
    if (heightOk && weightOk) {
      perfectMatches.push({ 
        size, 
        perfect: true,
        rec
      });
    }
  }
  
  if (perfectMatches.length > 1) {
    const sortedMatches = [...perfectMatches].sort(sortBySizeOrder);
    const matchingSizes = sortedMatches.map(m => m.size);
    return {
      success: false,
      reason: 'ambiguous',
      message: t.ambiguous,
      matchingSizes,
      alternatives: matchingSizes,
      showSizeGuide: true
    };
  } else if (perfectMatches.length === 1) {
    const matched = perfectMatches[0];
    const inStock = isSizeAvailable(product, matched.size, color);
    
    if (!inStock) {
      return {
        success: true,
        size: matched.size,
        confidence: 'high',
        inStock: false,
        alternatives: [],
        message: t.recommended_direct_with_unavailable(matched.size)
      };
    }
    
    return { 
      success: true, 
      size: matched.size, 
      confidence: 'high',
      inStock: true,
      alternatives: [],
      message: t.recommended_direct(matched.size)
    };
  }
  
  // No perfect match - look for closest match (within 5cm / 5kg)
  const heightWeightThreshold = 5;
  let closestMatches = [];
  
  for (const size of candidatesWithData) {
    const rec = recommendations[size];
    const heightInRange = h >= rec.heightMin && h <= rec.heightMax;
    const weightInRange = w >= rec.weightMin && w <= rec.weightMax;
    
    // Skip partial matches - need to evaluate both
    const heightDiff = heightInRange 
      ? 0 
      : h < rec.heightMin 
        ? rec.heightMin - h 
        : h - rec.heightMax;
    const weightDiff = weightInRange 
      ? 0 
      : w < rec.weightMin 
        ? rec.weightMin - w 
        : w - rec.weightMax;
    
    // Only consider if both are outside but within threshold
    if (!heightInRange && !weightInRange && heightDiff <= heightWeightThreshold && weightDiff <= heightWeightThreshold && heightDiff >= 0 && weightDiff >= 0) {
      closestMatches.push({
        size,
        rec,
        heightDiff,
        weightDiff,
        totalDiff: heightDiff + weightDiff
      });
    } else if (heightInRange && weightInRange) {
      continue;
    }
    // Partial match (one in range, other out) - don't give confident recommendation per requirements
  }
  
  if (closestMatches.length === 0) {
    return { 
      success: false, 
      reason: 'out_of_range', 
      message: t.out_of_range,
      showSizeGuide: true
    };
  }
  
  // Sort by total difference
  closestMatches.sort((a, b) => {
    if (a.totalDiff !== b.totalDiff) return a.totalDiff - b.totalDiff;
    return sortBySizeOrder(a, b);
  });
  
  const closest = closestMatches[0];
  const inStock = isSizeAvailable(product, closest.size, color);
  
  if (!inStock) {
    return {
      success: true,
      size: closest.size,
      confidence: 'closest',
      inStock: false,
      alternatives: closestMatches.slice(1, 3).map(m => m.size),
      message: `${t.closest(closest.size)}\n${t.recommended_direct_with_unavailable(closest.size).split('\n')[1]}`
    };
  }
  
  return {
    success: true,
    size: closest.size,
    confidence: 'closest',
    inStock: true,
    alternatives: closestMatches.slice(1, 3).map(m => m.size),
    message: t.closest(closest.size)
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
