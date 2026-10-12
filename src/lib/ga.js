// Google Analytics 4 loader. Analytics is disabled entirely unless
// REACT_APP_GA_ID is provided at build time (e.g. G-XXXXXXXXXX).
//
// The gtag bootstrap lives in this same-origin bundle (not an inline <script>)
// so it satisfies the site's strict `script-src 'self'` CSP; only the external
// gtag.js file is added to the page and its host is whitelisted in vercel.json.

const GA_ID = process.env.REACT_APP_GA_ID;

export function initGA() {
  if (!GA_ID || typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__zashmGaInit) return;
  window.__zashmGaInit = true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, { send_page_view: true });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(script);
}

// Sends a virtual page_view for the state-based router.
export function trackPageView(path, title) {
  if (!GA_ID || typeof window === 'undefined' || typeof window.gtag !== 'function') return;
  window.gtag('event', 'page_view', {
    page_path: path,
    page_title: title,
    page_location: window.location.origin + path,
  });
}
