import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const SUPABASE_ORIGIN_PLACEHOLDER = '__ZASHM_SUPABASE_ORIGIN__';

function supabaseOriginFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
        parsed.pathname === '/' && !parsed.search && !parsed.hash) return parsed.origin;
  } catch {
    /* invalid configuration is treated as no origin, never a Production fallback */
  }
  return '';
}

// Warm the TLS connection to Supabase before the first catalogue/image request.
// The product image is the LCP element on /product/:id and the products query is
// the first data request on every page, so a cold DNS+TLS handshake there costs
// hundreds of milliseconds on Slow 4G. The origin is read from the same env var
// the browser bundle uses, so no URL is hard-coded in the HTML.
function supabasePreconnect(url) {
  return {
    name: 'zashm-supabase-preconnect',
    transformIndexHtml(html) {
      if (!url) return html;
      let origin = '';
      try { origin = new URL(url).origin; } catch (e) { return html; }
      if (!origin) return html;
      const tag = `<link rel="preconnect" href="${origin}" crossorigin/>`;
      return html.replace('</head>', `  ${tag}\n</head>`);
    },
  };
}

// `public/_headers` is an environment-neutral template. Fill its Supabase
// placeholder from the exact URL used for this build so the static CSP can
// never grant an unintended project (for example Production) to Staging assets.
function supabaseHeadersOrigin(origin) {
  return {
    name: 'zashm-supabase-headers',
    apply: 'build',
    closeBundle() {
      const file = fileURLToPath(new URL('./build/_headers', import.meta.url));
      if (!existsSync(file)) return;
      const text = readFileSync(file, 'utf8');
      const next = text
        .split(SUPABASE_ORIGIN_PLACEHOLDER).join(origin)
        .replace("connect-src 'self'  ", "connect-src 'self' ");
      if (next !== text) writeFileSync(file, next, 'utf8');
    },
  };
}

function siteOriginFromEnv(env) {
  const raw = env.PUBLIC_BASE_URL || env.VITE_PUBLIC_BASE_URL || 'https://za-shm.vercel.app';
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.username && !url.password &&
        url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch {
    /* fall through to the known production origin */
  }
  return 'https://za-shm.vercel.app';
}

// Canonical/OG URLs must follow the deployment origin. The committed shell has
// a placeholder so no branch inherits the production domain; Vite replaces it
// from PUBLIC_BASE_URL at build time (default: the known production origin).
function siteOriginPlugin(origin) {
  return {
    name: 'zashm-site-origin',
    transformIndexHtml(html) {
      return String(html).split('PLACEHOLDER_SITE_ORIGIN').join(origin);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Keep the same precedence as configuredSupabaseOrigin() in worker.mjs so the
  // build-time _headers CSP and the request-time Worker CSP name one project.
  const supabaseUrl = env.VITE_SUPABASE_URL || env.REACT_APP_SUPABASE_URL || env.SUPABASE_URL || '';
  const siteOrigin = siteOriginFromEnv(env);

  return {
    plugins: [
      react(),
      siteOriginPlugin(siteOrigin),
      supabasePreconnect(supabaseUrl),
      supabaseHeadersOrigin(supabaseOriginFromUrl(supabaseUrl)),
    ],
    esbuild: {
      loader: 'jsx',
      include: /src\/.*\.js$/,
      exclude: [],
    },
    // The project uses JSX inside .js files. The dependency scanner runs its
    // own esbuild pass, and without this it fails to parse the entry graph,
    // then re-optimizes dependencies mid-session (which can reload the page
    // with two React copies and blank the UI during repeated reloads).
    optimizeDeps: {
      esbuildOptions: {
        loader: { '.js': 'jsx' },
      },
    },
    define: {
      'import.meta.env.REACT_APP_SUPABASE_URL': JSON.stringify(env.REACT_APP_SUPABASE_URL || ''),
      'import.meta.env.REACT_APP_SUPABASE_ANON_KEY': JSON.stringify(env.REACT_APP_SUPABASE_ANON_KEY || ''),
      'import.meta.env.REACT_APP_GA_ID': JSON.stringify(env.REACT_APP_GA_ID || ''),
    },
    // `vercel dev` starts its own proxy on --listen and expects the dev
    // command to read the port it assigns through PORT. Without this, the
    // fixed `--port 3000` makes `vercel dev` wait for a port that never
    // opens (DEV_PORT_DETECTION_TIMED_OUT).
    server: {
      port: Number(process.env.PORT) || 3000,
      strictPort: true,
    },
    build: {
      outDir: 'build',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('/node_modules/')) return undefined;
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
            if (/\/node_modules\/(framer-motion|motion-dom|motion-utils)\//.test(id)) return 'vendor-motion';
            if (/\/node_modules\/@supabase\//.test(id)) return 'vendor-supabase';
            if (/\/node_modules\/lucide-react\//.test(id)) return 'vendor-icons';
            if (/\/node_modules\/(recharts|d3-[^/]+)\//.test(id)) return 'admin-charts';
            if (/\/node_modules\/papaparse\//.test(id)) return 'admin-csv';
            return undefined;
          },
        },
      },
    },
  };
});
