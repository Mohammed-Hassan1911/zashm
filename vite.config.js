import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    esbuild: {
      loader: 'jsx',
      include: /src\/.*\.js$/,
      exclude: [],
    },
    define: {
      'import.meta.env.REACT_APP_SUPABASE_URL': JSON.stringify(env.REACT_APP_SUPABASE_URL || ''),
      'import.meta.env.REACT_APP_SUPABASE_ANON_KEY': JSON.stringify(env.REACT_APP_SUPABASE_ANON_KEY || ''),
      'import.meta.env.REACT_APP_GA_ID': JSON.stringify(env.REACT_APP_GA_ID || ''),
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
