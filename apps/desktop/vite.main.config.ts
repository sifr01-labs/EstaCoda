import { defineConfig } from 'vite';
export default defineConfig({ build: { rollupOptions: { external: ['electron', /^node:/], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
