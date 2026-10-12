import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Baked in at build time (FAMILYCFO_BASE_PATH=/a/familycfo for the hosted image); empty locally,
// so dev and a plain `npm run build` are unchanged.
const BASE_PATH = (process.env.FAMILYCFO_BASE_PATH ?? '').replace(/\/+$/, '');

// Local only: bind to 127.0.0.1 and proxy the API (which is also bound to 127.0.0.1). WEB_PORT / PORT change the ports.
export default defineConfig({
  base: `${BASE_PATH}/`,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 4310}` },
  },
});
