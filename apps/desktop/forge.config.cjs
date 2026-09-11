const { VitePlugin } = require('@electron-forge/plugin-vite');
module.exports = {
  packagerConfig: { asar: true, name: 'EstaCoda', executableName: 'EstaCoda', appBundleId: 'com.estacoda.desktop', prune: false },
  rebuildConfig: { onlyModules: [] },
  makers: [],
  plugins: [new VitePlugin({ build: [
    { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
    { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
  ], renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }] })],
};
