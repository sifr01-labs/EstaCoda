# Desktop workspace foundation

Desktop PR 1 registers this private workspace against `@estacoda/control-protocol`. There is no Electron app, renderer, bridge command or launch script yet; PR 5 owns Electron/Forge/Vite/React scaffolding. The only current consumer is the pure protocol import boundary.

Run `pnpm install --frozen-lockfile` at the repository root, then `pnpm run desktop:foundation:check`. It typechecks both source workspaces and rejects transitive protocol imports outside the pure contract boundary. Root CLI build/package commands remain independent of Desktop.

Before implementation, read the [architecture](../../docs/architecture/desktop/README.md), [decisions](../../docs/architecture/desktop/decisions.md), [threat model](../../docs/architecture/desktop/threat-model.md), [credential design](../../docs/architecture/desktop/credential-transactions.md) and [approved visual contract](../../docs/planning/desktop-visual-contract.md). The frozen prototype is a test/design reference, not source to embed in a production renderer.
