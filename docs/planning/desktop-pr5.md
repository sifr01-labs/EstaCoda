# Desktop PR5 implementation record

The frozen visual contract and acceptance matrix govern this implementation. Production enables bootstrap and existing Work inspection; future mutation/setup journeys require their planned milestones. Fixture builds have a separate entry point and no live bridge.

## Slice reviews

1. Scaffold: pinned Electron/Forge/Vite/React dependencies, private desktop scripts and bundles. Reviewed dependency placement and CLI separation. `desktop:foundation:check`, renderer build and unsigned Forge package verified on macOS arm64. Forge's renderer symlink preservation is disabled for pnpm resolution. The service is not rebuilt for Electron.

## Risk and scope

Electron Main, preloads, process launching and credential staging are trust boundaries. Renderer-visible capability hints never authorize execution. Signing, notarization and updates remain PR16.

2. Window policy: sandbox, context isolation, Node/webview/permission/navigation/download denial, production DevTools disabled, hardened fuses, exact top-frame/document/window/generation authority. Reviewed fail-closed sender checks; two unit tests, Desktop typecheck and hardened Forge package pass.

3. Service ownership: stage a relocatable standalone Node/core dependency closure, verify SQLite's Node ABI and executable/entry digests, spawn with fixed arguments and a minimal environment, isolate credential descriptor 3, and detach only the owned bridge. Profile validation preserves core identifier syntax. Desktop typecheck/four tests and initialization through the staged real bridge in a temporary profile pass. The checkout's stale dist was rebuilt from tracked sources in the clean validation copy; staging now rejects distributions without the private command.

4. Protocol client: bounded bytes/UTF-8 and pending requests, pure-contract correlation/profile validation, subscription identity and sequence checks, fresh snapshot after resync, bounded reconnect backoff, no mutation replay. Main now owns a profile-bound connection. Ten unit tests/typecheck and the real staged bridge bootstrap/list/subscribe/profile-switch smoke pass. Production UI wiring follows slice 6; live mutation methods are not negotiated.

5. Credential isolation: dedicated sandboxed local window/preload, separate private fd3 client with bounded requests and fixed errors, exact sender authority, opaque candidate responses, cancellation/window/profile/bridge invalidation. Ordinary renderer has no credential surface. Thirteen tests/typecheck and real fd3 synthetic staging/closed-window rejection pass. PR6 must add reviewed verification/apply; this slice neither saves nor verifies credentials.

6. Semantic preload: snapshot/subscription, bounded activity reads, selectable profile metadata and native window controls only; Main rejects extra authority fields and stale bindings. Canonical profile-home helpers are reused and the global profile pointer is never written. Fourteen tests, foundation typecheck, Forge package and actual Electron launch/preload/quit smoke pass; the latter verifies `require`/`process` are absent and no generic invoke or credential API is exposed. Review caught and fixed destroyed-window cleanup ordering.

7. Approved assets/tokens/primitives: exact official eye paths and raster-backed wordmark mask, bundled Lucide components, frozen effective colors and cascade-preserving removal of superseded declarations. Source prototype remains untouched. Chromium light/dark 1×/2× brand captures reviewed; ocean colors match and the wordmark has no visible rectangular backdrop. Typecheck/build pass. Vite development uses a per-server CSP nonce for its React preamble; production CSP remains unchanged. The supplied PR5 app icon and transparent image-tool derivative are recorded separately and converted to ICNS with native tooling.
