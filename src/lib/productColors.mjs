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

function parseHex(value) {
  const match = /^#([\da-f]{3,8})$/i.exec(String(value || '').trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((n) => n + n).join('');
  if (hex.length === 8) hex = hex.slice(0, 6);
  if (hex.length !== 6) return null;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function relativeLuminance([r, g, b]) {
  const channels = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

// One identical treatment for every name: the true fabric colour, the same
// bold contrasting rim and the same lit halo as Black. Only the rim colour
// flips to black on a light canvas, so the shape never changes between colours.
export function getColorTextStyle(color, background = '#0a0a0a') {
  const ink = getColorSwatch(color);
  const canvas = parseHex(background) || [10, 10, 10];
  const [r, g, b] = relativeLuminance(canvas) < 0.18 ? [255, 255, 255] : [0, 0, 0];
  return {
    color: ink,
    '--color-rim': `rgba(${r}, ${g}, ${b}, 0.92)`,
    '--color-glow': `rgba(${r}, ${g}, ${b}, 0.42)`,
    '--color-stroke': '0.5px',
    '--color-glow-size': '12px',
  };
}
