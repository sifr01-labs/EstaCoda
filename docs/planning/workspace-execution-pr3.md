# PR 3 — Host execution lease implementation record

Implemented on `ame/execution-baseline` in the nine planned commits, following the operator's instruction to continue the existing branch. This record describes local host behavior, not Desktop execution readiness or cross-process exclusivity.

## Delivered

1. Verified host environments, independently owned execution scopes and borrowed leases.
2. Selected-view filesystem operations with containment checks and preserved transactional patches.
3. Scope-owned command/background processes and separate child process managers.
4. Lease-backed Python harness execution.
5. Isolated child environments with explicit runtime configuration and preserved protected credential transport.
6. Bounded streaming/protocol resources, caller/scope cancellation and process-group escalation.
7. Construction-failure unwind, runtime retirement, child acquisition cleanup and owned temporary-state cleanup.
8. Conformance coverage for selected-view execution, unsaved editor content, shared environments and independent child scopes. Review during this step also migrated grep/glob fallbacks, notebooks, probe workers and context loading, and closed the child Session persistence-failure unwind path.
9. [Operational behavior, compatibility changes and limits](../operations/host-execution.md).

## Review and validation

Each implementation commit was reviewed and checked before committing. Focused coverage included existing patch rollback and path-security tests, command hardline tests, protected process transports, real process descendants, malformed/fragmented harness messages, output floods, timeout/cancellation, runtime/child lifecycle and ACP content provenance.

Validation used an isolated tracked checkout with only the reviewed PR 3 files overlaid. The operator checkout's unrelated untracked duplicate files were left untouched. No dependencies or lockfiles changed.

- Node v24.14.1; pnpm 10.33.0.
- `pnpm install --frozen-lockfile`.
- `pnpm run typecheck`.
- `pnpm run test --maxWorkers=2`: 10,480 tests across 603 files.
- `pnpm run smoke`: 13 cases.
- `pnpm run build`.
- `pnpm run audit:runtime-imports` and `pnpm run audit:esm`.
- `pnpm run smoke:dist`: 13 cases.
- `git diff --check`.

Process-tree testing exposed a duplicate immediate `SIGKILL` and a signal/exit race. The duplicate was removed; failed signals now require OS proof that the group is absent before cleanup succeeds. Deterministic tests cover both confirmed absence and an unconfirmed group. No tests were weakened to ignore termination failures. Default-concurrency runs also exposed existing CLI/supervisor timing timeouts; the supervisor suite passed independently, and the final complete suite used two workers without changing assertions or repository test configuration. Historical PR 0 measurements were not rerun as new performance benchmarks, and no live-provider, Desktop, Docker or Windows validation is claimed.

## Security and remaining scope

This change touches execution, filesystem access, child environments, editor provenance and lifecycle. Hardline policy and approval/trust authority remain required. Isolated environment variables and process groups are not OS containment. External side effects and escaped descendants cannot be recalled by an abort signal. Read-only ACP compatibility writes require explicit materialized mode and verified buffer/disk parity.

PR 0 observations B06 and B07 are addressed by scoped process/environment cleanup and bounded cancellable harness execution. PR 4 ownership/cache/revocation observations remain open. Cross-process Session claims, supervisor control IPC, Docker and managed worktrees are not delivered by PR 3.
