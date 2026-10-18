import { defineConfig } from 'vite';

// The pages live in public/ and are copied to dist/ as they are; the server
// serves dist/. /colyseus is proxied to a local server in dev.
export default defineConfig({
  server: {
    proxy: {
      '/colyseus': { target: 'http://localhost:2567', changeOrigin: true, ws: true, rewrite: (p: string) => p.replace(/^\/colyseus/, '') },
    },
  },
});
