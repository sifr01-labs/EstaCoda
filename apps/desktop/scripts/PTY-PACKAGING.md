# Desktop PTY packaging

Desktop pins node-pty 1.1.0 (N-API), xterm 6.0.0 and fit addon 0.11.0. Only Main loads node-pty; only the sandboxed renderer loads xterm. The protocol package imports neither.

Forge's Vite plugin omits node_modules. `stage-pty.mjs` copies the pinned PTY package into the packaged app, and the asar rule unpacks its native binary and spawn helper. The core Node/SQLite runtime is staged separately and must never be rebuilt against Electron.

The pinned macOS prebuild lacks the helper's executable bit. `prepare-pty.mjs` corrects that exact dependency asset after install, and packaging repeats the correction on the copied asset. Version changes require reviewing these guards and testing native spawn in Electron, not only a Node import.

The terminal is a privileged native dependency. Do not pass renderer-selected executables, environment variables, or absolute working directories to it. xterm output must remain text; do not enable HTML rendering, automatic URL opening, clipboard escape handlers, or terminal-derived approval decisions.

## Owned runtime closure

Package on a native runner matching the target OS and architecture. `stage-runtime.mjs` rejects cross-architecture staging before building: copying the host Node/native modules into another architecture's installer is not supported. Forge does not rebuild SQLite or Sharp against Electron. Staging probes both with the bundled standalone Node; the N-API PTY package is separately exercised inside Electron.

Runtime manifest v2 inventories every regular file by relative path, size and SHA-256, excluding the manifest itself. The bridge verifies the complete closure before launch and rejects changed, missing, extra, linked or special assets. This is an integrity check, not publisher authentication. Legacy v1 runtime manifests require restaging.

`node apps/desktop/tests/package-check.mjs` checks the finalized macOS arm64 package, then relocates it to a space/Arabic path in a temporary HOME. It probes SQLite and Sharp with the relocated Node, PTY from the relocated asar with pinned Electron, and the unchanged hardened app's owned bridge. This local ad-hoc signature is not Developer ID signing or notarization and does not establish public release or updater acceptance.
