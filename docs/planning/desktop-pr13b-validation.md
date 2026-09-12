# Desktop PR13B — Integrated browser workspace

Implemented on `ame/desktop-foundation`, based on the current PR13 ownership boundary. This record describes shipped behavior and the checks performed; the planning documents retain their separate roadmap scope.

## Supported execution owner and backend

Interactive workspace actions use the existing supervisor-owned runtime and its supervised `local-cdp` backend. Desktop does not create a second runtime, attach directly to CDP, or start a supervisor implicitly. The current supervisor RuntimeCache must already contain the selected Work's runtime. A Work projection with a changed target generation is rejected.

Configure the local browser through the existing reviewed configuration path: `browser.backend: "local-cdp"`, `browser.supervised: true`, and either a reachable configured CDP endpoint or managed Chromium auto-launch. Availability inspection does not launch Chromium. Opening a session after takeover may launch the configured local browser. The complete in-Desktop configuration journey remains a PR14B dependency.

Cloud, hybrid, legacy local CDP, extraction-only backends, foreground CLI/ACP runtimes, and worker runtimes outside the supervisor RuntimeCache do not acquire interactive control through this route. Desktop explains unavailability and retains PR12 recorded viewing. This PR neither starts billable cloud sessions nor introduces a cloud fallback. Browser extensions and general-purpose browser replacement are outside its scope.

## User journey

1. Open Browser from Session or attempt Work. Recorded views remain available independently of takeover.
2. For a supported active owner, choose **Take control** and accept Main's native consent dialog. The runtime lease pauses agent browser actions.
3. Enter an HTTP(S) address and open a session, or select an existing runtime-owned session. New sessions use isolated browser contexts and runtime-generated IDs.
4. Switch tabs, open a tab at the entered address, navigate, use back/forward/reload, or close sessions and secondary tabs. The original tab owns the isolated context: use **Close session** to close it. History actions at the end of available history make no navigation.
5. **Refresh live view** obtains a bounded sanitized capture. Captures show observation time and browser readiness; they are explicitly refreshed, not continuous video. Workspace actions discard the previous frame. Failed or uncertain actions are not retried automatically.
6. For protected sign-in, focus the password or one-time-code field, choose the intended submit button from the current frame, then choose **Enter securely**. A separate local credential window collects the value and explicitly submits it to that field/button. Refresh afterward to verify the result; “submitted” does not assert successful authentication. Ordinary typing into recognized password/code fields is blocked. Unsupported/ambiguous fields fail closed.
7. Choose **Return to agent** when finished. Closing the view, losing the window, or disconnecting stops renewal; it does not resume browser execution. Reacquire control to inspect or explicitly return it. A stale runtime instance cannot accept an old lease.

The lease governs browser actions, not unrelated tools or an entire provider turn. Browser lease expiry is not a durable pause across replacement runtime instances.

## Ownership and sensitive-data boundaries

- Main holds the private holder, lease, sequence, selected browser ID and connection generation. The ordinary renderer receives a local opaque handle, bounded inventory and sanitized frames. Renderer IPC does not accept CDP methods, scripts, credentials, lease fields or caller-selected profile authority.
- Every mutation is sequenced under the existing runtime lease. Creation, tab activation/closure, navigation, native input, protected delivery and protected submission recheck ownership at dispatch. Renewals remain valid across runtime-generated browser-ID changes within the same lease.
- Navigation, history destinations and tabs retain HTTP(S), private-network, website-blocklist and cloud-metadata policy. The supervised browser's existing request interception also checks redirects. No permission or cloud-spend checks were relaxed.
- Protected entry binds the current document, tab, origin, focused field and selected submit control. The existing protected form controller verifies them again before delivery and submission. Cancellation and incomplete challenges clear protected state; uncertain cleanup keeps execution fenced.
- Raw password/code submission uses `credentials.browserDeliver` on the dedicated, bounded, non-logged inherited pipe. The ordinary JSON-RPC browser route explicitly rejects raw delivery commands. The bridge forwards the transient value only to the authenticated existing runtime owner; it creates no credential candidate, configuration write, transcript entry, artifact, ordinary event or durable operation receipt for delivery.
- The credential window retains its isolated local renderer, exact sender/frame checks, disabled production DevTools and denied remote navigation/permissions. JavaScript cannot guarantee complete memory zeroization; values and temporary byte buffers are discarded/cleared promptly. A compromised credential renderer or OS remains outside this isolation guarantee.
- Inventory is bounded to eight sessions and sixteen total visible tabs, with explicit truncation. Captures use bounded pixels and compressed bytes, leaving room for metadata in control frames. Sign-in field/button metadata is bounded. Secret-bearing URLs are withheld.
- Closing owned sessions releases their isolated contexts. Managed Chromium shutdown now waits for process exit before removing its temporary profile, with bounded cleanup retries. User-supplied browser profiles and externally owned Chrome processes are not deleted or killed by this cleanup.

## Eight implementation commits

1. `8f533771` — session/tab lifecycle and ownership checks.
2. `5fe4c392` — leased navigation, history and reload.
3. `eed02615` — bounded runtime/control-service workspace state and actions.
4. `68b22d92` — Desktop sessions, tabs, address and navigation controls.
5. `5bc3a62d` — protected sign-in, dedicated credential pipe and explicit return.
6. `91f4c819` — policy, stale Work target/lease, renewal and cleanup regressions.
7. `90367ed4` — UI, real Chromium and packaged-app verification; shutdown cleanup fix.
8. This implementation record.

## Validation on this machine

Node 24.14.1 and pnpm 10.33.0. Broad core validation used an isolated copy of tracked files because the working directory contains pre-existing untracked duplicate TypeScript sources. Those files and the user's concurrent planning changes were preserved. Desktop tests and the real Chromium journey ran against the working implementation.

Passed:

- Frozen-lockfile offline install; core typecheck and build; Desktop typechecks and pure protocol boundary check.
- Full core suite: **11,005 tests across 691 files passed**.
- Focused browser/security integration suite: 268 tests, followed by the additional tab-cleanup regression; Chromium launcher suite: 24 tests.
- Desktop unit suite: 73 tests.
- Full browser/interaction/approved-visual suite: 159 tests. No approved visual snapshots were regenerated. Narrow browser workspace layout was also inspected.
- Real Chromium against a loopback-only fixture: session creation, protected sign-in, sanitized observation, secondary tabs, history, reload, session cleanup and explicit return. Uses a synthetic password, temporary browser profile and explicit fixture-only private-URL permission; no external account or provider call.
- Rebuilt macOS arm64 Desktop package; package content checks, semantic browser preload and private-delivery presence, requested icon, CSP, hardened fuses, signature verification, packaged PTY and relocated hardened app launch.
- Source smoke, runtime-import audit, ESM audit and distribution smoke.
- Independent commit-2 checkout: typecheck and 101 focused tests passed after placing its TypeScript narrowing fix in that commit. The final validated tree was unchanged by the history correction.
- `git diff --check`.

Reproduce the live local fixture with `node --import tsx apps/desktop/tests/native-browser-workspace.mts`. It uses the installed Playwright Chromium; it does not download a browser or require an external account. Reproduce packaging with `pnpm run desktop:package` and `node apps/desktop/tests/package-check.mjs` on macOS arm64.

The remaining acceptance gate is PR14B's complete reviewed browser setup flow. External websites, CAPTCHA/provider-specific authentication, cloud takeover, Windows/Linux packaging, and long-running reliability were not established by this local fixture or package smoke. Existing trust, profile isolation and approval policies remain required.
