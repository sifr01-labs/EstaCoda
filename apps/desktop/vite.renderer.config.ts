import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ base: './', resolve: { preserveSymlinks: false }, plugins: [react()], build: { sourcemap: false } });
