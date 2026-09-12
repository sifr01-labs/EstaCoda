# Desktop PR13 — browser takeover

The six plan items are grouped into the four commits requested by the operator: runtime lease; agent gating; authenticated core acquisition; desktop input, regression tests and this security record.

## Ownership and input

The existing runtime owns a monotonic, generation-fenced browser lease. Acquisition requires no browser operation to be in flight and immediately blocks subsequent agent browser operations. The gate covers the complete backend, including screenshots, raw CDP and protected-field transports; synchronous protected-field accessors retain their synchronous contracts. Status remains readable. The browser gate does not pause unrelated tools or the whole provider turn. Blocked agent browser operations fail with an explicit paused state; returning control permits subsequent operations and does not replay rejected operations.

The desktop bridge forwards authenticated requests to the selected profile's existing shared supervisor. RuntimeCache only borrows an existing, healthy canonical Session runtime and pins it during control operations. Accepted browser-control calls also participate in SharedSessionHost shutdown draining, without writing input receipts. It never constructs or reacquires a runtime for takeover. Target generation, workspace trust, runtime execution health and live configuration authority are rechecked. Window/profile/connection generations fence Main requests. Browser ID, holder, runtime instance and lease generation bind the human controller. Competing acquisition, concurrent input and reused or skipped sequence numbers fail closed.

Electron Main displays native consent describing the URL, paused browser agent actions and potential external effects. Main owns the holder token, lease, renewal and input sequence. Preload exposes only open, frame/input, explicit release and abandon using a temporary Main handle. The renderer cannot supply a lease, holder, sequence, profile override, script, endpoint, CDP method or keyboard modifier.

After takeover, Refresh live view obtains an ephemeral sanitized frame from the existing browser. Clicking maps normalized image coordinates to the original screenshot pixels. The backend consumes its screenshot-bound visual lease to resolve a current semantic target before dispatch. Keyboard input is a bounded named key or one printable Unicode character, including Arabic. Input is serialized; unsupported modifier chords, paste payloads and out-of-bounds coordinates are rejected. The UI waits for the new frame before accepting another input. It is deliberately not a high-frequency remote-desktop stream.

Each input consumes its frame and sequence. Document/action identity, tab and URL policy are checked before dispatch; frame capture is checked again afterward. Images are sanitized by the existing backend and bounded to 960 × 640 pixels, 16 million decoded input pixels and 45,000 JPEG bytes. URL credentials, secret-bearing URLs, blocked websites and cloud metadata remain denied; explicit private-URL policy retains its existing meaning. Protected-input transactions suppress observation. Typed keys and live frames are not written into Session transcripts, control receipts, artifacts or memory. Visible ordinary page content can still be sensitive; backend sanitization does not promise arbitrary content classification.

## Return, failure and availability

Return to agent is an explicit release and requires settled human input. Main renews an active lease every two seconds; core expires it after ten seconds using monotonic time. Expiry, a closed view, renderer failure, an unresponsive window, profile change, lost connection or uncertain input never implicitly resumes agent browser actions. They fence input and leave the owner paused. A fresh explicit acquisition followed by Return to agent recovers a settled paused owner. An old live lease must expire before another controller can acquire. In-flight uncertain input blocks replacement until it settles. Closed runtime owners cannot be resurrected by late promise rejection.

Takeover currently supports existing supervised local-CDP sessions in the selected supervisor's RuntimeCache. Foreground CLI/ACP owners, executor-owned worker runtimes outside that cache, closed Sessions and unsupported browser backends remain view-only. The feature creates no cloud session, new tab or browser process and authorizes no additional cloud spend. Session/tab lifecycle, navigation, protected human sign-in and the integrated browser workspace remain the separately planned PR13B work. Browser takeover does not grant operating-system computer control.

The lease is ephemeral and belongs to the runtime instance. Runtime restart or eviction invalidates its handles; there is no lease recovery from a timestamp, renderer state or PID alone. Existing supervisor/runtime ownership still governs process recovery. No new browser state database or second execution owner is introduced.

## Validation record

Checks on 2026-09-12:

- Node 24.14.1 and pnpm 10.33.0; frozen offline dependency installation passed.
- The complete frozen-source core run passed 10,985 tests across 691 files. The final supervisor-drain correction passed nine focused host/private-control tests.
- All 69 desktop unit tests and 154 browser/visual tests passed. The final focus styling also passed six focused browser cases. The new view was visually inspected without changing approved golden images.
- Core and desktop/protocol typechecks, the pure protocol import-boundary check, source smoke, build, runtime-import audit, ESM audit and distribution smoke passed.
- Native browser backend and dispatch regressions passed, including expiry between geometry resolution and mouse press, uncertain input, closed-owner resurrection, stale frames, document/tab binding, serialized sequences and Arabic character input.
- A real authenticated local-socket test verified acquisition, competing-holder rejection, explicit release, profile isolation, no runtime creation and no persisted input receipts. RuntimeCache regression coverage proves that an existing runtime remains pinned during control and invalidation.
- Final whitespace/diff checks passed.
- No dependencies, lockfiles or approved screenshot goldens changed. No packaged Electron application rebuild, real external website takeover, live provider or cloud-browser test was performed for this PR.

Broad checks use an isolated tracked-source copy because this checkout contains pre-existing untracked duplicate TypeScript files. Concurrent planning/design-document edits are preserved and excluded from these commits. Initial validation caught a new test's Promise typing error and asynchronous React-cleanup assertion timing; both were corrected. The last complete core run uses a frozen source tree after an earlier run overlapped synchronization of the dispatch regression and implementation.

## Browser review follow-up

[The focused browser correction](desktop-browser-review-fixes.md) adds current observation without takeover, restores paused-owner reacquisition, queues bounded typing, and prioritizes selected tabs. It supersedes the recorded-only viewing and one-input-at-a-time UI limitations described above; recorded inspection remains available.
