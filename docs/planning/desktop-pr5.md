# Desktop PR5 implementation record

The frozen visual contract and acceptance matrix govern this implementation. Production enables bootstrap and existing Work inspection; future mutation/setup journeys require their planned milestones. Fixture builds have a separate entry point and no live bridge.

## Slice reviews

1. Scaffold: pinned Electron/Forge/Vite/React dependencies, private desktop scripts and bundles. Reviewed dependency placement and CLI separation. `desktop:foundation:check`, renderer build and unsigned Forge package verified on macOS arm64. Forge's renderer symlink preservation is disabled for pnpm resolution. The service is not rebuilt for Electron.

## Risk and scope

Electron Main, preloads, process launching and credential staging are trust boundaries. Renderer-visible capability hints never authorize execution. Signing, notarization and updates remain PR16.
