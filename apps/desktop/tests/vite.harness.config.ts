import{defineConfig}from'vite';
export default defineConfig({build:{outDir:'.test-build',lib:{entry:'tests/harness-exports.ts',formats:['cjs'],fileName:()=> 'exports.cjs'},rollupOptions:{external:['electron',/^node:/]}}});
