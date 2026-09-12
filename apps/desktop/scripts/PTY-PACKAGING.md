# Desktop PTY packaging

Desktop pins node-pty 1.1.0 (N-API), xterm 6.0.0 and fit addon 0.11.0. Only Main loads node-pty; only the sandboxed renderer loads xterm. The protocol package imports neither.

Forge's Vite plugin omits node_modules. `stage-pty.mjs` copies the pinned PTY package into the packaged app, and the asar rule unpacks its native binary and spawn helper. The core Node/SQLite runtime is staged separately and must never be rebuilt against Electron.

The pinned macOS prebuild lacks the helper's executable bit. `prepare-pty.mjs` corrects that exact dependency asset after install, and packaging repeats the correction on the copied asset. Version changes require reviewing these guards and testing native spawn in Electron, not only a Node import.

The terminal is a privileged native dependency. Do not pass renderer-selected executables, environment variables, or absolute working directories to it. xterm output must remain text; do not enable HTML rendering, automatic URL opening, clipboard escape handlers, or terminal-derived approval decisions.
