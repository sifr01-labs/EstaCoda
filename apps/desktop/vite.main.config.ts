import { defineConfig } from 'vite';
export default defineConfig({ build: { rollupOptions: { external: ['electron', 'node-pty', /^node:/], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
