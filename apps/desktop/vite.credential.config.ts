import { defineConfig } from 'vite';
export default defineConfig({ base:'./', cacheDir:'.vite/cache/credential-window', build: { rollupOptions:{input:'credential.html'}, sourcemap:false } });
