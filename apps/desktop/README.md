# EstaCoda desktop

Private Electron client workspace. Run `pnpm desktop:dev` from the repository root. PR5 delivers the approved interface and isolated fixture journeys, with live profile bootstrap, existing Work/activity/attention inspection, reconnect and presentation preferences. Provider setup, new execution, approvals, attachments, search, pins and integrations become live in their subsequent planned PRs; release controls identify their current availability.

## Build and validate

From a clean source checkout with the root frozen install completed:

```sh
pnpm run desktop:foundation:check
pnpm run desktop:test
pnpm run desktop:e2e
pnpm run desktop:package
pnpm run desktop:native
```

`desktop:e2e` runs the reviewed visual and interaction gate without updating goldens. See [visual evidence](tests/visual-evidence/README.md). `desktop:native` requires macOS Apple Silicon, a graphical session, the packaged bundles/runtime, and local socket/process access. It creates synthetic temporary profiles and never calls a provider. Its real IPC/lifecycle checks use the same built bundles in development Electron for Playwright attachment; a separate check launches the unchanged hardened package. See [native evidence](tests/native-evidence/README.md).

Forge rebuilds core and packages Vite assets with an owned standalone Node runtime and its dependency closure. Electron never rebuilds core dependencies for Electron's ABI. Release assets use a restricted `estacoda:` protocol, exact Main-owned window authority and a separate credential partition/pipe. Fixture code, reference assets and test hooks are excluded from the package.

The macOS output is `out/EstaCoda-darwin-arm64/EstaCoda.app`, with `EstaCoda.app.zip` containing the locally ad-hoc-signed bundle. The final signature is applied after Forge finalizes metadata and verified strictly outside File Provider folders. Such folders can synthesize FinderInfo metadata on `.app` directories; the archive preserves the verified bundle, and the package test verifies a relocated data-and-symlink copy. Developer ID signing, notarization, distribution and updates remain PR16. The supplied icon and transparent derivative have [recorded provenance](assets/icons/PR5-PROVENANCE.md).

Desktop inspection does not implicitly migrate a legacy database. A profile whose database predates execution ownership needs repair/migration through the owning core installation before inspection is available. The app reports this condition; the native tests verify current-schema persisted Work separately.
