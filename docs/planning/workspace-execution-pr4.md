# Workspace execution PR 4 implementation record

Status: implemented on `ame/execution-baseline` in the thirteen prescribed commits, continuing the existing branch as requested. This slice supplies the core runtime coordinator, cross-process Session ownership, shared supervisor control and compatible recovery. It does not claim the later Desktop integration or sandbox release gates.

## Delivered commits

1. Common workspace/configuration/Session-owner/environment acquisition with failure unwind.
2. Separate metadata, build, definition and authority revisions.
3. SQLite Session claims, owner fences, heartbeat and turn/control revisions; no live-owner takeover based on expiry.
4. CLI, ACP, child/delegation and Task/cron acquisition through the runtime owner boundary, preserving Task host/Attempt admission.
5. Transactional profile supervisor singleton and instance-aware discovery/release.
6. Shared Session hosting in that supervisor and authenticated, bounded private Unix IPC.
7. Durable accepted-operation receipts, exact-input retry deduplication and priority cancellation/approval.
8. Current selected-profile configuration, persisted trust and appropriate MCP reconstruction.
9. Serialized cache acquisition, leased environment health validation and settled replacement.
10. Live revocation checks at execution boundaries plus cancellation of owned resources.
11. Additive checkpoint binding, historical definition provenance and current-governance recovery.
12. Cross-surface, independent-process, private-control, revocation and recovery regressions. Review also closed stale singleton cleanup races, channel cancellation routing, live assessor refresh and on-demand startup ownership.
13. [Acquisition, migration and recovery documentation](../operations/runtime-ownership.md), with updated plan and baseline status.

## Review and validation

Each implementation slice was reviewed and checked before its commit. The test slice explicitly covers independent-process exclusion and recovery after confirmed exit, expired-but-live ownership, fenced late writes, cache races and failed cleanup, live trust/approval revocation, incompatible target recovery, private endpoint authentication, exact-input receipt retries after a lost response, channel-owned cancellation, and safe on-demand supervisor startup.

Validation used an isolated checkout containing tracked source and explicitly reviewed new files. Unrelated untracked duplicate files and `exports/` in the operator checkout were left untouched. The isolated checkout received a frozen dependency installation; no dependency or lockfile change is part of PR 4.

Executed checks:

- Node v24.14.1 and pnpm 10.33.0.
- `pnpm install --frozen-lockfile` (network-enabled retry after an offline cache miss).
- `pnpm run typecheck`.
- Focused runtime, Session, gateway, channel, Task, approval and checkpoint tests throughout the commits.
- Final `pnpm run test --maxWorkers=2`: **10,511 tests in 609 files passed**.
- `pnpm run smoke`: **13 cases passed**.
- `pnpm run build`.
- `pnpm run audit:runtime-imports` and `pnpm run audit:esm`.
- `pnpm run smoke:dist`: **13 cases passed**.
- `git diff --check` and changed-document local link checks.

The first broad run exposed 19 failures in stale schema fixtures, fixtures without persisted trust, the changed revocation result contract and the baseline's old gap assertions. Tests were updated after checking the intended migration/security behavior; trust enforcement and owner fences were not weakened. Subsequent full runs passed, including the final two added regressions. Private socket/process checks required execution outside the tool sandbox. Local Node 24 validation does not replace the CI Node 22 lane or other operating-system validation.

## Security and remaining scope

This slice changes execution ownership, authorization freshness, local control and persistence. It preserves selected-profile isolation, workspace trust and non-overridable hardline checks. A routing ID, cache entry, checkpoint or expired heartbeat never grants authority. A cancellation request is not proof of termination; a lost response is not proof that an operation failed. Uncertain dispatched mutations require reconciliation and are not automatically replayed.

The minimal shared client is an exported core API; there is no new public CLI command or Electron integration. Unix socket path limits apply, and Windows shared IPC remains unsupported. Direct skill-file edits load at runtime reconstruction rather than through live prompt mutation. Foreground transfer requires settled disposal and explicit reacquisition; unsaved ACP buffers and live resources are not migrated. On-demand startup reuses existing supervisor/service ownership and introduces neither service installation nor automatic idle shutdown.

Signed Desktop launch/quit/reconnect, two-window/channel attachment, UI profile isolation and the complete cross-surface continuation journey remain Desktop/PR 5 integration gates. Docker containment, managed worktrees and recurring-work grant extensions remain later slices. No live provider/account, paid execution, production service deployment or new performance/cost benchmark was exercised. PR 0 observations B01, B02, B04 and B05 are closed at the core runtime layer; see the [baseline follow-up](workspace-execution-baseline.md#pr-4-follow-up).
