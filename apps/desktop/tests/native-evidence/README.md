# PR5 native acceptance evidence

macOS arm64 / Electron 44.3.0. Run `pnpm run desktop:package` then `pnpm run desktop:native` from the repository root in a graphical session. Tests explicitly override Electron home and userData before loading production Main; setting HOME alone is insufficient on macOS. All displayed Work, pending approvals and credentials are synthetic temporary data. No model requests, approval resolutions, user-profile writes or runtime dispatches occur.

- `results.json` and `canonical-work.png`: actual Main/preload/standalone Node bridge reads current-schema persisted Work and pending attention. Profile switches, reload, bridge termination, supervisor restart, incompatible host and quit/relaunch preserve canonical ownership.
- `native-200-percent.png`: settled 200% zoom, reachable composer and no horizontal overflow. Electron's native capture API avoids CDP's clipped Retina zoom screenshot. Resize checks also exercise 1280, 736 and 360 px.
- `incompatible-host.png`: explicit recovery state for an existing incompatible owner; Desktop does not replace it.
- `package.json`: fixture exclusion, strict release CSP, hardened fuses including file-protocol privilege denial, exact supplied-icon derivative hash, strict local signature verification, and unchanged packaged launch from a path containing spaces and Arabic.

Boundary checks reject a foreign genuine renderer with the same preload/document, forged profiles, credential calls from an unrelated renderer, arbitrary local-file fetch, external navigation, popups and notification permission. Synthetic credential submission uses the real private descriptor 3, clears the input, exposes no ordinary-renderer staging API and closes authority on reload. Unit tests additionally check stale generations, protocol bounds and correlation, credential pipe failures, presentation validation and bounded reconnect backoff.

These results cover PR5 bootstrap/inspection and credential transport, not PR6 provider verification/apply or PR7 live Work mutations. Native evidence supplements the 104-test [visual/interaction gate](../visual-evidence/README.md); it does not replace that gate. Operating-system title-bar controls are native on the tested macOS platform and therefore absent from renderer-only captures. Windows/Linux native release validation remains outstanding.
