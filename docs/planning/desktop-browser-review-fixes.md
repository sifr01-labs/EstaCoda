# Desktop PR12–13B review corrections

This focused follow-up addresses the four gaps found when reviewing browser inspection, takeover and the integrated workspace against the original desktop plan.

## Current behavior

- **Recovery:** inventory reads use an existing, quiescent runtime owner in either agent or paused state. They never release the pause. After an abandoned lease expires (up to ten seconds), Desktop can reacquire through native consent and explicitly return control. A transient inventory error does not permanently disable takeover. Active human ownership, in-flight browser actions and closed owners still reject competing inspection or acquisition.
- **Typing:** the takeover UI buffers at most 64 pending keys and sends them in order with a fresh frame for each input. A runtime-derived context identifier binds queued text to the browser session, document, tab and focused element. Focus/document changes, protected fields, uncertain input and closing the view discard remaining queued keys. Overflow and context changes are visible; input is never automatically retried after failure. Modifier chords, paste and IME composition remain unsupported. Arabic printable characters retain their existing support.
- **Watch live:** the existing Browser dialog offers bounded current observations of supervised local sessions without acquiring control. Requests run every two seconds after the previous request completes, between browser actions. Agent calls arriving during an observation wait for that read; an already executing browser action takes precedence. Native synchronous metadata accessors retain their existing semantics. Failed/busy/unsupported reads clear the image and show availability honestly. Closing, changing profile/connection, selecting another session or entering takeover discards late frames. Watching resumes after explicit Return to agent if it was enabled before takeover. Recorded observations and verified retained captures remain available separately.
- **Inventory:** the selected session and its controlled tab have first claim on the existing eight-session/sixteen-tab projection budget. Selecting a session requests that session's prioritized inventory. Truncation remains explicit; this adds neither unbounded enumeration nor unrestricted CDP references.

## Ownership and security review

Observation requests use the existing authenticated, profile- and Work-scoped browser control route. They do not construct a runtime, create a session, navigate, acquire an input lease or persist frames. Current workspace trust and execution ownership are still checked. The renderer receives bounded sanitized pixels and metadata only. Raw CDP, secrets and caller-selected profile/lease authority remain excluded.

Read-only capture does not register a visual input lease or replace the agent's previous screenshot lease. Its returned frame cannot be submitted as takeover input. Protected-input suppression, URL/private-network/metadata policies and image limits remain unchanged. Owner closure invalidates a pending read; failed observation never resumes a paused owner. Protected sign-in still uses the dedicated credential pipe.

The concurrency and input paths are security-sensitive. Regression coverage exercises recovery through the real Main/runtime classes, observation/input exclusion, agent arrivals during observation, preservation of screenshot grounding, unknown sessions, revoked trust, protected input, frame/context changes, bounded typing and late replies. No dependency, lockfile, approved visual golden or ownership-policy relaxation is required.

## Validation

Validated on 2026-09-12 with Node 24.14.1 and pnpm 10.33.0:

- Frozen offline installation passed. Core typecheck, build, runtime-import audit and ESM audit passed, including a final rerun after the observation-only capture correction.
- Complete core suite: **11,009 tests across 691 files passed**. After the final screenshot-reference correction, **199 focused browser/lease/protocol tests passed**.
- Desktop unit suite: **75 tests passed**. Desktop/protocol typechecks and the pure protocol import-boundary check passed.
- Complete desktop interaction/visual suite: **163 tests passed**. Five final live/recorded-view tests passed after presentation adjustments. Live-view and narrow takeover screenshots were inspected; approved goldens were not changed.
- Real local Chromium fixture passed again after the capture correction: session creation, protected sign-in, current observation without a lease, tab lifecycle, history/reload, cleanup and explicit return.
- Source and distribution smoke: **13/13 cases passed in each**. Final whitespace checks passed.

Broad core checks used the existing isolated tracked-source copy because the working checkout contains pre-existing duplicate TypeScript files. The final capture correction was reviewed and tested with the focused suite, typecheck/build/audits and real Chromium; the complete core suite was not repeated after that narrow change. No provider credentials, external websites, cloud sessions or new package downloads were used. Packaged Electron was not rebuilt for this correction.

Complete in-Desktop browser configuration remains PR14B work; cloud takeover, external authentication providers, cross-platform packaging and long-duration reliability remain outside this correction.
