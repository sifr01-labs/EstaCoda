const { VitePlugin } = require('@electron-forge/plugin-vite');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseVersion, FuseV1Options } = require('@electron/fuses');
module.exports = {
  packagerConfig: { extendInfo: { NSMicrophoneUsageDescription: 'Record audio you choose to send for transcription with your configured speech provider.' }, asar: { unpackDir: 'node_modules/node-pty' }, name: 'EstaCoda', executableName: 'EstaCoda', appBundleId: 'com.estacoda.desktop', icon: 'assets/icons/pr5-app.icns', prune: false, extraResource: ['.runtime'] },
  hooks: { packageAfterCopy: async (_config, buildPath) => { await import('./scripts/stage-pty.mjs').then(module => module.stagePty(buildPath)); }, generateAssets: async (_config,platform,arch) => { require('node:child_process').execFileSync(process.execPath, ['scripts/stage-runtime.mjs',platform,arch], { cwd: __dirname, stdio: 'inherit' }); }, postPackage: async (config, result) => { if (result.platform === 'darwin' && result.arch === 'arm64' && !config.packagerConfig.osxSign) require('node:child_process').execFileSync(process.execPath, ['scripts/finalize-local-macos.mjs', ...result.outputPaths], {cwd: __dirname, stdio:'inherit'}); } },
  rebuildConfig: { onlyModules: [] },
  makers: [],
  plugins: [new FusesPlugin({ version: FuseVersion.V1, [FuseV1Options.RunAsNode]: false, [FuseV1Options.GrantFileProtocolExtraPrivileges]: false, [FuseV1Options.EnableCookieEncryption]: true, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.EnableNodeCliInspectArguments]: false, [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, [FuseV1Options.OnlyLoadAppFromAsar]: true }), new VitePlugin({ build: [
    { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
    { entry: 'src/preload/credential.ts', config: 'vite.credential-preload.config.ts', target: 'preload' },
    { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
  ], renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }, { name: 'credential_window', config: 'vite.credential.config.ts' }] })],
};
