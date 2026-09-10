# Approved Desktop design · version 1

Approved in the product design conversation on 10 September 2026. This directory freezes the final branded workspace concept selected by the user. It is a design reference, not shipped Desktop functionality.

- [Visual and interaction contract](../desktop-visual-contract.md): requirements and delivery ownership.
- [Acceptance matrix](acceptance-matrix.md): states and checks required for Desktop PR 5.
- [Interactive preview](preview.html): open this file in a modern browser. This generated inspection wrapper adds 16 px around the product and loads pinned Lucide and tooltip helpers from unpkg.com; it is not an offline or production app.
- [Approved source](approved-prototype.html): byte-for-byte copy of the final `estacoda-branded-workspace` fragment, including its embedded brand assets. Its effective CSS cascade and default settings are the reference; earlier declarations can be superseded later in the file.
- [Manifest](manifest.json): SHA-256 identities of the frozen source, preview, and assets.
- [Official icon](assets/estacoda-icon.svg): supplied vector, unchanged. The prototype crops its empty viewBox space for display without changing its paths.
- [Wordmark reference](assets/estacoda-wordmark-reference.png): supplied wordmark image recovered from the approved prototype's embedded PNG because the original screenshot location was temporary. This is a raster reference, not an original vector wordmark.

The preview contains simulated Work, approvals, credentials, connections, schedules, and timers. It must never be used with real credentials or treated as runtime evidence. File selection records metadata only; it does not upload files or read their contents. Reload to reset the scenario. The default is Kemet, System appearance, comfortable density, 224 px sidebar, collapsed inspector, and New chat.

The wrapper was intentionally generated with the Visualize `render.py` exporter (package version 1.0.29). Only the inner approved fragment defines product appearance. Wrapper CSP, CDN dependencies, simulated window controls, design-tuning controls, and demo state are not production requirements. Production must use bundled assets and the secure Electron policy in the implementation plan.

Do not overwrite version 1 to make an implementation pass. Proposed visual changes need a side-by-side comparison and explicit product approval before replacing the approved baseline. Preserve prior identities and document the reason for an approved revision. Routine accessibility and native-window adaptations are handled by the contract's exception rules.
