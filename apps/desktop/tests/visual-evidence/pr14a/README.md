# PR14A bilingual visual evidence

Captured on macOS 26.5.2 (25F84), Apple silicon, with Electron 44.3.0 and Playwright 1.63.0.

- `../../e2e/bilingual.spec.ts-snapshots/` contains 28 reviewed references: English/Arabic × light/dark × 360/1280-pixel widths × approval/Settings/Models, plus four CSS 200% reflow references.
- `native-*-zoom200.png` are actual Electron `webContents.capturePage()` viewport captures at `setZoomFactor(2)`, with the display-language control focused. They are evidence, not screenshot-comparison baselines.
- `native-Electron-zoom-and-accessibility-*.json` records the non-ignored button and combobox names from Electron Chromium’s accessibility tree in each language/theme. Only fixture control names are retained.
- `manifest.json` records SHA-256 hashes of these captures and the bilingual references. Historical PR5 references remain unchanged.

The native harness renders the current fixture in an isolated Electron BrowserWindow with sandbox/context isolation enabled and Node integration disabled. Its temporary userData is removed afterward. It does not launch a real agent, contact a provider, or access production credentials.

Run from the repository root:

```sh
pnpm --filter @estacoda/desktop e2e tests/e2e/bilingual.spec.ts tests/e2e/native-language.spec.ts
```

The native tests run on macOS and skip elsewhere. They require permission to launch Electron and bind the local fixture server. Review screenshot differences before intentionally accepting new references. Update the manifest after replacing reviewed evidence.

Review checked Arabic shaping, alignment, sidebar placement, command readability, mixed-language content, narrow reflow, and focused controls at 200% zoom. Keyboard and accessibility-tree tests are automated evidence; they do **not** claim an actual VoiceOver listening session or signed-distribution acceptance. Those remain explicit manual acceptance checks.
