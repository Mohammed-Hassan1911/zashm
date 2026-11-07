import React from 'react';
import { Star } from 'lucide-react';

/**
 * Read-only star rating. Rounds to the nearest whole star (the data is stored
 * with one decimal, so a 4.6 shows five stars and 4.4 shows four). Used on
 * product cards and in the product-page review summary.
 */
export default function StarRating({
  rating = 0,
  size = 12,
  color = 'var(--gold)',
  emptyColor = 'var(--text3)',
  style,
}) {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  const filled = Math.round(value);

  return (
    <span
      role="img"
      aria-label={`${value.toFixed(1)} out of 5 stars`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 1, lineHeight: 0, ...style }}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          size={size}
          strokeWidth={1.5}
          aria-hidden="true"
          color={star <= filled ? color : emptyColor}
          fill={star <= filled ? color : 'none'}
        />
      ))}
    </span>
  );
}
