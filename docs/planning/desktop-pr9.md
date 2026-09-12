# Desktop PR9 — Execution targets

Implemented on `ame/desktop-foundation` in the nine commits defined by the Desktop plan. This slice extends shared core targets; it does not create a Desktop workspace registry or execution owner.

| Commit | Implemented and reviewed scope | Focused validation |
| --- | --- | --- |
| 1 — Project core targets | Immutable ID/generation and source/working-root projections; ready, untrusted, unavailable and archived states | Profile and stale-reference projection tests; Desktop protocol/type boundary |
| 2 — Managed provenance | Discriminated Git worktree variant; directory/common-directory/registration identity; format 3 compatibility; no local reinterpretation | Existing target regressions; core typecheck |
| 3 — Creation and verification | Frozen source commit, generated destination/branch, explicit trust, pre-effect creation journal, bounded Git invocation, disabled hooks/filters | Real Git creation, replay refusal, HEAD drift and hook/filter canaries |
| 4 — Archive and cleanup | Separate archive and physical cleanup; dirty/ignored refusal; retained branch; core borrower guards through runtime resource settlement | Real Git cleanup, borrower blocking and runtime acquisition/retirement tests |
| 5 — Service lifecycle | Validated, advertised target methods; bridge-scoped expiring reviews; profile-bound operation reconciliation | Protocol conformance; service creation/archive/cleanup and token-scope tests |
| 6 — Desktop integration | Main-owned references, narrow IPC/preload, reviewed target manager, immutable existing Work, attachment reset on draft target change | 50 Desktop unit tests; 141 browser/visual checks; inspected narrow review rendering |
| 7 — Identity/profile regression coverage | Cross-profile/local-reclassification refusal, generation race recheck, symlink/repository replacement, immutable Sessions and uncertain cancellation | Target, registry and stdio boundary regressions; core typecheck |
| 8 — Trust/ownership/cleanup coverage | Concurrent creation, crash-left receipts/borrowers, revoked trust, all dirty classes, locked worktrees, runtime writes, native and Docker execution | Full release, native and targeted UI checks detailed below |
| 9 — Documentation | Operator trust/lifecycle/recovery guide, control-service method reference, architecture status and workspace ownership documentation | Documentation review and local link/patch checks |

## Findings fixed during review

- Managed roots and children cannot be acquired as fresh local targets in another profile. Original target provenance stays authoritative.
- Validation rechecks generation/status after asynchronous path resolution, closing an archive race.
- Worktree creation is classified as a mutation even when its operation ID is carried by a review token; cancellation never claims that Git effects were undone.
- The newly created Git root is verified before checkout. Source and working-root identity cannot silently diverge through Git configuration.
- Managed working files use `<home>/.estacoda-worktrees/<profile>/<UUID>`, outside protected runtime state. The Docker protected-state boundary was preserved, with a real-container regression.
- Concurrent global trust updates reproduced lost/corrupt grants. Shared trust writers now use the existing OS-released SQLite lock and atomic file replacement. Tests cover unrelated grants/revocations and two independent worktree creations.
- Disconnecting clears the target dialog’s old readiness/details. This adds a fifth target browser journey without changing approved visual baselines.

## Validation evidence

Environment: macOS, Node 24.14.1, pnpm 10.33.0, Git 2.53.0; existing prepared Docker image. Core build/release checks used the tracked-source validation copy because pre-existing unrelated duplicate TypeScript files in the working directory interfere with root typechecking. Those files were preserved.

- Required `validate:execution-release` gate: **10,927 tests across 678 files**, frozen install, typecheck, smoke/build, runtime-import/ESM audits, distribution smoke, execution budgets, source/distribution Docker conformance and Docker image validation.
- The Docker gate now exercises managed worktree files/commands and proves source/runtime state remain outside the single bind. Dirty cleanup is refused afterward.
- Desktop foundation/type/protocol boundary and **50 Desktop unit tests** passed.
- The complete **141-case browser/visual suite** passed. The final focused **five target journeys** passed after adding disconnect clearing. Approved golden images were unchanged.
- Native Main/preload/bridge, credential isolation, approval/profile/owner restart, package contents/CSP/fuses/icon/relocation checks passed. Real Desktop created a managed worktree, completed a canonical Session, and continued a running Task across app restart without request replay; the persisted Session retained the worktree’s actual working-root binding.

One intermediate full run hit the existing five-second Bun/SQLite compatibility-test timeout. Its isolated rerun passed, followed by the full suite with unchanged assertions/timeouts. No live model provider or third-party messaging account was required; native provider output is scripted locally.

## Scope and risk review

Git operations, trust writes, profile isolation and cleanup are security-sensitive. Core checks immutable roots, profile/generation/provenance and cleanup ownership. Runtime borrower guards persist until resources settle; crash-left guards block physical cleanup instead of guessing that descendant processes stopped. No force removal, branch deletion, credential exposure, new shell bridge or shared-owner transfer was added.

Alpha intentionally retains uncertain operations and partial directories for inspection. There is no automatic orphan adoption/rollback, dead-borrower repair, unarchive, custom branch/destination picker or journal compaction UI. Lists inspect the first 100 target records and report truncation. Git hooks/content filters are disabled during creation; LFS and submodules are not hydrated. Docker does not mount the source/shared Git metadata, so Git commands requiring it are unavailable inside that environment. Live files/diff/PTY remain PR10.

See [the operator guide](../architecture/desktop/worktrees.md) for exact trust, cleanup and recovery behavior. Production soak monitoring and the later packaging/accessibility milestones remain distinct from these checks.
