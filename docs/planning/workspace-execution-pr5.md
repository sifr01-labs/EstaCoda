# Workspace execution PR 5 implementation record

Status: implemented and validated on `ame/execution-baseline` in the seven prescribed commits. This slice adds channel workspace selection and recurring authority through the existing core registry, supervisor, approval store and setup flow.

## Seven commits

1. `86f648f6` — profile-local channel workspace/source/target bindings and atomic future Session selection in the existing workspace database.
2. `287ce2bf` — authenticated `/workspace`, `/workspace list`, and `/workspace use <alias>`, with trust checks and fresh Session preparation.
3. `614a5dd0` — checked attachment/switching, input admission barriers and shared-owner lifetime preservation.
4. `ab67eade` — persistent grant reuse for channel-origin cron work, immutable origin/target attribution, live authority validation and origin-bound delivery.
5. `974f5a6d` — complete-surface continuation/grant scope, explicit incompatible-state blockers, fresh serialized handoff/view persistence, one-use recurring dispatch and canonical service installation paths.
6. `5e358081` — separate-process recovery, selection/approval and recurring authority tests. Review also closed background context/child-scheduling scope loss, made default Session publication atomic, and updated lifecycle/smoke fixtures for the implemented contracts.
7. `docs(channels): document host sandbox and recurring-work choices` — operational guidance, migration, security boundaries and plan status.

Each implementation slice was reviewed and tested before its commit. The sixth commit includes fixes found by its acceptance review rather than deferring known gaps.

## Acceptance and evidence

| Requirement | Implemented behavior and evidence |
|---|---|
| Registered aliases only | Remote commands resolve core profile-local registrations; invalid paths and untrusted directories are rejected. Gateway and workspace-store regressions cover selection without provider construction. |
| Future selection cannot retarget work | Selection commits a fresh Session pointer and fixed source/target snapshot. Input admission, active turns, queues, debounce buffers and approvals block pointer changes. Stop/approve/deny remain reachable. |
| Shared owner and checked foreground boundary | Supervisor attachment validates Session profile, target and trust, then rejects a foreign live owner. Views borrow the supervisor runtime; detach/reset does not retire that owner. Foreground execution must settle and close first. |
| Recurring approval reuse | A current matching persistent channel grant authorizes the same reviewed tool/risk/target in a new cron Session. Other profiles, workspaces, accounts/chats/threads, legacy grants and stale authority do not match. Hardline denials remain final. |
| Complete recurring scope | Authenticated origin survives background tools, child scheduling and upstream-output reads. Current target/trust/channel policy gates execution and delivery. A regression verifies other-origin output cannot enter the scheduled prompt. |
| Restart and migration | Handoff/view JSON is read fresh and updated under a kernel-owned SQLite mutex with atomic publication. A separate-process test verifies one redemption and no lost independent pointer writes. Unknown/corrupt state fails closed; channel Session format 2 records its profile. |
| Existing host workflows | Local host remains available without Docker. Channel setup retains existing reviewed trust/config apply; service metadata pins a physical directory instead of following a mutable symlink or alias. |
| Canonical approval orchestration | Local operator decisions continue through `ChannelGateway`, including continuation and delivery; clients do not mutate queue rows or forge channel messages. |

## Validation

Validation uses an isolated temporary checkout synchronized from tracked source and explicitly reviewed new files. Unrelated untracked duplicate files and `exports/` in the operator checkout are excluded and untouched. No dependencies or lockfiles changed.

Executed checks:

- Node v24.14.1 and pnpm 10.33.0.
- `CI=true pnpm install --frozen-lockfile`.
- Typecheck and focused channel, workspace, supervisor, runtime, approval, service and cron tests before implementation commits.
- Separate OS-process handoff redemption and independent surface-pointer publication.
- Final `pnpm run test --maxWorkers=2`: **10,536 tests in 613 files passed**.
- Focused final publication/lifecycle tests: 16 passed; final typecheck passed.
- `pnpm run smoke`: **13 cases passed**, including WhatsApp after its fake runtime supplied the required Session lookup.
- `pnpm run build`, `pnpm run audit:runtime-imports`, and `pnpm run audit:esm` passed.
- `pnpm run smoke:dist`: **13 cases passed**.
- `git diff --check` and 61 local document links passed.

The first broad run exposed a fixture accessing a closed supervisor-owned workspace database. It now writes state while the supervisor is live. The first source smoke exposed a fake runtime missing the Session lookup used for origin attribution; the fake now implements that contract. Production ownership and origin checks were preserved.

## Risk and remaining delivery gates

This is security-sensitive channel, persistence, approval and scheduled-execution work. It preserves the local trusted-operator model; Local host is not OS containment or multi-tenant isolation. A canonical path identifies a path, not an inode or its contents. Approved effects already sent to an external service cannot be recalled, and tests do not establish exactly-once external effects.

Back up global Session state together with profile workspace, gateway and cron state with all processes stopped. Legacy underspecified attachments require a fresh checked handoff; legacy jobs receive no inferred origin/grant. Unsupported formats block recovery. Older writers must use a compatible pre-upgrade snapshot. Profile migration is not accomplished by renaming a state directory.

Task approvals retain their existing hierarchy/Attempt gates; a channel grant is not generic Task authority. Unattended work that exceeds its grant still needs renewed approval. The default Session mapping has one supervisor writer; cross-process handoff and attached-view writers use their separate serialized stores.

Packaged Desktop multi-window/channel attachment, real Telegram/provider accounts, Windows protected IPC, Node 22 CI, other OS service lifecycle checks, Docker parity, managed worktrees and production latency/cost measurements remain their respective delivery gates. This PR does not claim those proofs or make Docker a prerequisite for existing host work.

See [workspace operations](../operations/workspaces.md), [channel configuration and migration](../operations/channel-configuration.md), [recurring authority](../subsystems/cron.md#channel-origin-recurring-authority), and [runtime ownership](../operations/runtime-ownership.md).
