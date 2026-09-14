# EstaCoda desktop

Private Electron client workspace. Run `pnpm desktop:dev` from the repository root. PR5 delivers the approved interface and isolated fixture journeys, with live profile bootstrap, existing Work/activity/attention inspection, reconnect and presentation preferences. Work reached through Inbox resolves independently of list pagination. Tabs, inspector visibility and loaded history extent survive navigation within a profile; switching profile clears them. Activity inspection is bounded to 2,000 loaded items without changing canonical history. PR6 adds live provider setup, reviewed primary/fallback/specialist routes, Codex OAuth, bounded candidate verification, and Session/Task model overrides. See [Models and Providers](../../docs/architecture/desktop/models-and-providers.md). PR7 connects new conversations and bounded durable Tasks, lifecycle controls, approve-once/reject, native text attachments, metadata search, profile pins, Inbox navigation and canonical usage/counts. See [Desktop Work](../../docs/architecture/desktop/work.md) for exact bounds and recovery semantics. Integrations continue in their planned milestones.

## Build and validate

From a clean source checkout with the root frozen install completed:

```sh
pnpm run desktop:foundation:check
pnpm run desktop:test
pnpm run desktop:e2e
pnpm run desktop:dev:smoke
pnpm run desktop:package
pnpm run desktop:native
```

`desktop:e2e` runs the reviewed visual and interaction gate without updating goldens. See [visual evidence](tests/visual-evidence/README.md). `desktop:native` requires macOS Apple Silicon, a graphical session, the packaged bundles/runtime, and local socket/process access. It creates synthetic temporary profiles and sends one bounded request to a test-owned loopback provider fixture. It does not use a paid provider or real-account authorization. Its real IPC/lifecycle checks use the same built bundles in development Electron for Playwright attachment; a separate check launches the unchanged hardened package. See [native evidence](tests/native-evidence/README.md).

Forge rebuilds core and packages Vite assets with an owned standalone Node runtime and its dependency closure. Electron never rebuilds core dependencies for Electron's ABI. Release assets use a restricted `estacoda:` protocol, exact Main-owned window authority and a separate credential partition/pipe. Fixture code, reference assets and test hooks are excluded from the package.

`desktop:dev:smoke` requires a graphical session and local process/socket access. It launches the actual Forge development build twice with an isolated temporary profile and checks that live onboarding renders without failed asset requests. It does not configure a provider or execute agent work. Reports stay in the printed temporary evidence directory. Each renderer uses a separate local Vite dependency cache. Development permits only main-frame reloads of the exact already-loaded development URL; packaged windows still reject renderer-initiated navigation. If upgrading a running development instance after a startup fix, stop it with Ctrl+C and run `pnpm run desktop:dev` again.

The macOS output is `out/EstaCoda-darwin-arm64/EstaCoda.app`, with `EstaCoda.app.zip` containing the locally ad-hoc-signed bundle. The final signature is applied after Forge finalizes metadata and verified strictly outside File Provider folders. Such folders can synthesize FinderInfo metadata on `.app` directories; the archive preserves the verified bundle, and the package test verifies a relocated data-and-symlink copy. Developer ID signing, notarization, distribution and updates remain PR16. The supplied icon and transparent derivative have [recorded provenance](assets/icons/PR5-PROVENANCE.md).

Desktop inspection does not implicitly migrate a legacy database. A profile whose database predates execution ownership needs repair/migration through the owning core installation before inspection is available. The app reports this condition; the native tests verify current-schema persisted Work separately.

PR14D connects profile-scoped Library skills, memory, Evidence, and reviewed Agent Evolution decisions. See [Library and Evolution](../../docs/planning/desktop-pr14d-library.md) for promotion gates, supported skill restoration, cancellation, and operation recovery, and [PR14D validation](../../docs/planning/desktop-pr14d-validation.md) for the evidence and limits.
