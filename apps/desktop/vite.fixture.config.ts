import{defineConfig,mergeConfig}from'vite';import renderer from'./vite.renderer.config.js';
export default defineConfig(async env=>mergeConfig(typeof renderer==='function'?await renderer(env):renderer,{build:{outDir:'.fixture',rollupOptions:{input:'fixture.html'}}}));
