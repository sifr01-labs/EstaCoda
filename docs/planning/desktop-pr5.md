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

8. Appearance: independent theme/appearance/density preferences, bounded atomic Main-owned presentation persistence, reactive CSS System mode, stable React component identity, and theme previews derived from the actual palette. The first fixture consumer has a separate HTML/build entry and an in-memory preference store, with no preload or real settings access. Fifteen tests/typecheck, fixture build and Chromium exercise of all nine theme/mode combinations plus an OS appearance change pass. Preview swatches intentionally use the true palette as required by the contract.

9. Navigation: approved neutral sidebar, top Settings, Search/New chat, primary navigation, ordered pins and workspace/draft rows. Draft text is retained per Work; new chats create independent local drafts. Fixture content search, pin/unpin, navigation and draft restoration pass in Chromium; sidebar screenshot reviewed, typecheck and fifteen unit tests pass. Production search/pins/new execution remain visibly unavailable until PR7 rather than implying fixture mutations are live.

10. Work UI: approved composer/attachments, Work tabs, collapsed tool activity, scoped fixture approval, deterministic completion/cancellation/partial evidence, Inbox routing and responsive inspector. Production reads canonical activity and pending attention without offering unsupported mutations. Native window chrome avoids duplicate title bars and the viewport supplies scroll/composer constraints. Eighteen unit tests/typecheck/fixture build pass; Chromium verifies draft+attachment restoration, approval→running→requested→cancelled, incomplete Results, and 360px inspector without horizontal overflow. Approval and narrow screenshots reviewed. Native viewport acceptance remains in slices 14–15.

11. Browse views: artifact preview/source-Work links, expandable capability rows with explicit visibility/authority distinction, Telegram/Email fixture details, and status-strip background/schedule inspection. Live views identify unavailable projections instead of presenting sample accounts, files or schedules. Eighteen tests/typecheck and Chromium artifact→source, capability, Telegram and schedule journeys pass; dark Connections capture reviewed.

12. Models/setup fixtures: approved provider rows and Configure→simulated verification→Review→Apply→Ready dialog, sample credential only, local auth-none route, cancellation, inert background, focus trap/restoration and persistent fixture-added route. Production Add provider is disabled pending PR6. Eighteen tests/typecheck/fixture build and Chromium setup/apply/Escape/local-route/focus checks pass; review-dialog capture inspected. No credential entry or network verification exists in the fixture adapter.
