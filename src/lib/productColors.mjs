const COLOR_SWATCHES = {
  black: '#111111',
  white: '#ffffff',
  red: '#d62828',
  green: '#2e8b57',
  blue: '#2563eb',
  yellow: '#facc15',
  burgundy: '#800020',
  maroon: '#800000',
  beige: '#d8c3a5',
  navy: '#172554',
  gray: '#808080',
  grey: '#808080',
  brown: '#795548',
  pink: '#ec4899',
  purple: '#8b5cf6',
  orange: '#f97316',
  gold: '#c9a84c',
  silver: '#c0c0c0',
  olive: '#808000',
  khaki: '#c3b091',
  teal: '#0f766e',
  charcoal: '#36454f',
  cream: '#fffdd0',
  'برجاندي': '#800020',
  'برغندي': '#800020',
  'نبيتي': '#800020',
  'أسود': '#111111',
  'اسود': '#111111',
  'أبيض': '#ffffff',
  'ابيض': '#ffffff',
  'أحمر': '#d62828',
  'احمر': '#d62828',
  'أخضر': '#2e8b57',
  'اخضر': '#2e8b57',
  'أزرق': '#2563eb',
  'ازرق': '#2563eb',
  'أصفر': '#facc15',
  'اصفر': '#facc15',
  'بيج': '#d8c3a5',
  'كحلي': '#172554',
  'رمادي': '#808080',
  'بني': '#795548',
  'وردي': '#ec4899',
  'موف': '#8b5cf6',
  'برتقالي': '#f97316',
  'ذهبي': '#c9a84c',
  'فضي': '#c0c0c0',
  'سكري': '#fffdd0',
};

export function getColorSwatch(color) {
  const name = String(color || '').trim();
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(name)) return name;
  return COLOR_SWATCHES[name.toLocaleLowerCase()] || COLOR_SWATCHES[name] || '#8a8a8a';
}

const DARK_CANVAS_LUMA = 0.0103; // relative luminance of #1a1a1a, the colour pill
const MIN_INK_CONTRAST = 4.5;

function parseHexColor(value) {
  const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(String(value || '').trim());
  if (!match) return null;
  let digits = match[1];
  if (digits.length < 6) digits = digits.split('').map((d) => d + d).join('');
  return {
    rgb: [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)),
    alpha: digits.length === 8 ? digits.slice(6) : '',
  };
}

function hexFromRgb(rgb, alpha) {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}${alpha}`;
}

function relativeLuminance([r, g, b]) {
  const [rl, gl, bl] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function rgbToHsl([r, g, b]) {
  const [rn, gn, bn] = [r, g, b].map((v) => v / 255);
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => Math.round((v + m) * 255));
}

// The bead keeps the true fabric colour; only the label is lit. Dark inks are
// raised along their own hue until they clear 4.5:1 on the dark pill, with
// saturation capped at a muted tint so burgundy stays a wine rose rather than
// turning neon. Black reads as light graphite, navy as a brighter slate blue.
export function getColorTextInk(swatch) {
  const parsed = parseHexColor(swatch);
  if (!parsed) return swatch;
  if (contrastRatio(relativeLuminance(parsed.rgb), DARK_CANVAS_LUMA) >= MIN_INK_CONTRAST) return swatch;
  const [h, s, l] = rgbToHsl(parsed.rgb);
  const inkSaturation = Math.min(s, 0.55);
  for (let next = l + 0.02; next <= 0.96; next += 0.02) {
    const candidate = hslToRgb(h, inkSaturation, next);
    if (contrastRatio(relativeLuminance(candidate), DARK_CANVAS_LUMA) >= MIN_INK_CONTRAST) {
      return hexFromRgb(candidate, parsed.alpha);
    }
  }
  return `#ffffff${parsed.alpha}`;
}

// Every name keeps its own fabric hue, lifted only enough to stay readable.
// The glass and the travelling shine live in CSS; the ink is the one value the
// swatch contributes, so no colour gets a private cloud, rim or halo.
export function getColorTextStyle(color) {
  const ink = getColorTextInk(getColorSwatch(color));
  return {
    color: ink,
    '--color-ink': ink,
  };
}
