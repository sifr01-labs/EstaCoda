# Desktop PR11: artifacts and evidence

PR11 extends the existing profile-owned ArtifactStore, durable Session registration events, and Task Results. Desktop owns no artifact database and copies no content into a second store. The Library and Results integrations preserve the approved theme, layout components, and fixture reference.

## Retained outputs

Session registrations keep digest, MIME type, byte count, display name, sanitized source origin, and optional core-supplied target/source/application/evidence references. Existing version-1 registrations remain readable. Temporary-copy exports persist their execution target generation and registered source workspace reference when available. Task and Attempt links come from canonical profile-owned records; display references never confer access or execution authority.

Retention creates a fresh private file rather than sharing the capture inode. Hydration and each preview independently verify content size, MIME and SHA-256. Reads use regular-file descriptors, reject symlink leaves and changed content, and have an explicit size bound. Desktop additionally rejects aliased profile content roots. Failed persistence leaves an inert unreferenced object; it does not publish a broken registration or delete unrelated files.

Library lists retained Session artifacts and canonical Task Results in pages of at most 32 records. The UI holds at most 512 entries. Session registration events are read in bounded projections rather than loading entire transcripts. Invalid registrations never become Library entries. Session artifacts are retained until removed through their existing owner; Task Results preserve their canonical available, expired and pruned behavior. Desktop does not introduce retention extension, garbage collection, or resurrection of pruned content.

`artifacts.open` means a verified, read-only in-app preview. It never invokes an external application, executes content, follows a source URL, or exposes a backing path. Text previews are limited to 16 KiB and rendered as escaped plain text. Binary outputs show metadata only. Sensitive text is redacted for display. The digest describes the retained original bytes; the visible redacted/truncated preview is not a byte-for-byte export. Missing, altered, expired or pruned content is explicitly unavailable. Unsupported retained formats do not silently fall back to host file reads.

## Completion and evidence

The Results view separates canonical completion from verified execution. Session evidence is bound to the latest canonical user turn and its final outcome. A completed transcript, successful tool message, retained artifact, Task Result or agent claim does not independently establish verification.

The evidence projection consumes the existing harness-generated execution receipts. A mutation needs a matching, later, compatible validation receipt from the same turn. Unclassified effects, unresolved failures, missing turn bindings, incomplete outcomes and inspection truncation prevent verified completion. Reads require observed read receipts and the appropriate completion requirement. Task verification additionally requires completed steps in the active plan and verified latest attempts; old plans and superseded successful attempts cannot stand in for current work.

Evidence reads at most 1,024 receipts per Session and shows at most 64 facts. Task inspection considers at most 128 attempts and reports truncation. Results expose up to 16 retained output references separately from verification facts. Previewing those outputs checks ownership and integrity again. Artifact integrity confirms bytes, not the correctness of their claims or the completeness of a real-world task.

Source Work links are rechecked in the current profile before navigation. Window/profile/connection generations fence requests; disconnected views clear displayed artifacts and evidence and discard late responses. Evidence responses contain classified receipts rather than raw tool payloads. Artifact previews are explicit user-content reads with display redaction; the new APIs expose no process handles or execution capabilities.

## Operational limits

- This is inspection, not an output editor, external opener, download manager or artifact capture UI. Existing producers and accepted content formats remain authoritative.
- Legacy or incomplete receipts may display unverified even when a person knows the work succeeded. The UI does not infer missing proof from prose.
- The Task projection is deliberately conservative about failed or missing attempts, unclassified effects and incomplete verification. Its label proves only the effects covered by recorded checks.
- Session retention reads are bounded at 96 MiB, matching the existing workspace change-artifact ceiling; Task Result reads preserve the existing 10 MiB per-step limit. Binary content is not rendered.
- Retained artifacts remain inspectable after an execution target is archived; their immutable provenance is historical metadata, not a live target capability.

## Validation record

Checks on 2026-09-12:

- Node 24.14.1 and pnpm 10.33.0; frozen-lockfile installation passed.
- Full core suite: 10,963 tests across 685 files passed. The final public-preview allowlist also passed focused core/protocol regression checks; the final retention-root correction passed 38 artifact, download and workspace-copy tests.
- Core typecheck, source smoke, build, runtime-import audit, ESM audit and distribution smoke passed.
- Desktop/protocol typechecks and import-boundary checks passed. All 64 desktop tests passed, including native PTY regressions.
- All 148 browser/visual cases passed. The new artifact and evidence screens were visually reviewed; final focused checks also confirmed containment at 360px width. Approved golden images were not changed.
- The final macOS arm64 package built and was locally signed. Native Main/preload/core checks passed for retained artifact preview and unverified completion evidence, alongside credential, profile, reconnect and ownership regressions.
- Package contents, CSP, hardened Electron fuses, supplied icon, relocated application launch, and PTY spawning from relocated asar assets passed.
- Native execution verified managed-worktree file/diff/PTY alignment, canonical Session completion, Task continuation across app restart, persisted worker Results and no request replay.
- Final whitespace/diff checks passed.

Core and package checks run from an isolated copy of tracked sources because the checkout contains pre-existing untracked duplicate TypeScript files. Four core-test workers avoid the machine's previously observed process-startup contention. The first browser run exposed a single-subscriber limitation in an older test harness; the harness now follows the real preload's multiple-subscriber contract, and both focused continuity checks and the full rerun passed. No production profile-switch or history assertion was weakened.

Tests use isolated temporary profiles and local scripted providers; no live model-provider request or external message is required.
