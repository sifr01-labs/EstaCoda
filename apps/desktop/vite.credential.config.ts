import { defineConfig } from 'vite';
export default defineConfig({ base:'./', build: { rollupOptions:{input:'credential.html'}, sourcemap:false } });
