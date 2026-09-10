# Host and Docker execution release

The first execution release supports ordinary Local host work, optional profile-local workspace names, immutable Session target bindings, scoped approvals, shared Unix execution ownership, optional local Docker, and explicit temporary copies. No registry or Docker setup is required for ordinary host launch. There is no Remote backend choice.

## Choose and diagnose execution

Run `estacoda doctor` (or `estacoda doctor --json`) from the intended workspace and selected profile. The execution check reads current policy and trust. Host reports explicitly that files and command networking are not sandboxed. Unsupported mandatory host controls block readiness; unsupported advisory controls produce a warning. Docker diagnostics inspect the local engine and selected immutable image without starting a container or approving work. Actual container controls remain verified during acquisition.

A trust blocker requires reviewing the directory in local setup. An engine/image or policy blocker requires reviewing Execution in Setup Editor. There is no automatic host fallback. A healthy readiness check does not grant tool authority or prove an active Session's ownership; dispatch still checks current target, trust, grants and owner fences.

See [workspaces](workspaces.md), [host behavior](host-execution.md), [runtime ownership](runtime-ownership.md), [Docker controls](docker-execution.md), and [temporary-copy workflows](temporary-copies.md) for commands and detailed boundaries.

Application results explain applied, review, conflict and attention outcomes without copying private paths or raw errors into the summary. `workspace finish`, `workspace apply` and `workspace recover` accept `--json` for detailed local inspection. The human summary includes the retained artifact ID. Conflicts require reviewing source changes and preparing a fresh baseline; attention requires local inspection of authority and recovery state. Repeating a command does not widen authority. Runtime result summaries support Arabic and isolate technical identifiers. The standalone workspace command currently uses English summaries.

## Required validation

Prepare the controlled execution image through the reviewed setup flow or the existing CI image-build step. Then run:

```bash
pnpm run validate:execution-conformance
pnpm run validate:execution-release
```

For a local engine whose shares exclude the validation checkout, provide an engine-shared temporary-file parent:

```bash
pnpm run validate:execution-release /path/shared/with/engine
```

The conformance command selects the core ownership/surface/environment/application suites and fails if a required test file is absent. The release wrapper checks patch hygiene and the presence of all 38 required conformance files, and runs frozen installation, typecheck, the full test suite, source smoke, production build, import/ESM audits, distribution smoke, measured host fixtures, real source and compiled Docker execution, and package-image build/startup. Any failed or timed-out stage stops the gate. Package-image validation is forced into its non-skipping mode. CI uses this wrapper on Linux with Node 22.18.0. Local results do not substitute for that CI result.

The Docker gate never downloads or prepares its execution image. It measures cold acquisition and warm file reads and exercises file/code/process/network/lifecycle behavior, copy application and guarded rollback. It requires settled owned receipts at the end; uncertain cleanup is a failure, not permission to remove foreign resources.

## Observations and budgets

Existing trajectories now include fixed-size cumulative execution counters and hashed definition/authority references. Checkpoints retain the same references and recovery rules. Counters record provider completions, dispatched attempts, available total-token reports, tool results/failures, ask/deny decisions, cancellations, checkpoint updates and completed/failed agent turns. Elapsed time uses a monotonic clock and includes idle time within that recorder's lifetime. Counters saturate at one billion; provider attempt inspection is capped at 256 entries per event. Compression retains these observations. SQLite saves one replaceable `execution-observations` event in its existing event JSON and reconstructs the diagnostic fields on load; no table or schema version is added.

These are observations, not grants, billed-cost accounting, or proof that copy application or an external effect completed. An absent usage report is distinguishable from a zero-token report. Auxiliary work outside this recorder is not included. Existing usage/spend ledgers remain authoritative for their accounting. No user text, command, filename, token or private path is added to these metric/reference fields. Existing trajectory content and its retention policy are unchanged; there is no automatic trace-to-evaluation conversion or Evolution promotion.

`validate:execution-budgets` reruns three samples of each PR0 scenario: coding, authorized channel work, scheduled work and interrupted/resumed work. Every sample must complete, request zero approvals, and stay within PR0's scripted provider-call and synthetic token ceilings. Median runtime startup must be at most 1,000 ms and median scenario execution at most 2,000 ms. Docker cold acquisition is bounded to 60 seconds and three warm 8 MiB reads to 30 seconds. These deliberately generous fixture ceilings catch material regressions across development/CI machines; they are not production service objectives. A budget failure requires investigation, not automatic baseline replacement.

The [PR8 record](../planning/workspace-execution-pr8.md) contains the measured comparison and checks actually run. Provider fixtures are scripted; their results do not establish live model quality, cost, or production percentiles.

## Migration, recovery and threat model

No new database or mandatory migration is introduced by PR8. Trajectory fields are additive diagnostics; they confer no recovery authority. PR7's first temporary copy advances the profile workspace database to version 2, which older readers reject. Preserve compatible backups of profile workspace state, global Sessions, trust/approvals, retained artifacts and source/copy directories. Never edit a schema version to force a downgrade. Legacy unscoped approvals remain inspectable without becoming current grants.

Host execution trusts the local operator, operating system, runtime installation and same-user processes. Docker additionally trusts the local daemon, kernel and approved image. Docker is not hostile multi-tenant isolation. Host/browser/MCP capabilities retain separate gates; tool discovery does not authorize dispatch. Command-network containment does not imply all control-plane network traffic is disabled. Unavailable backends and unknown required controls cannot silently become host authority.

Live revocation fences new dispatch and cancels owned work with the documented external-operation limits. Expiry or sleep does not establish owner death. Stale fences cannot settle a successor's work. Lost responses use existing receipts, not automatic mutation replay. Copy recovery is per-file reconciliation, not an atomic multi-file transaction or a guarantee against power loss; later edits and uncertain state are preserved. Network effects, package installs and external database writes are outside file rollback.

Packaged Desktop multi-window/profile-switch/quit-relaunch behavior, signed delivery and Windows private transport remain separately unvalidated delivery gates. Core tests exercise their shared contracts without claiming a Desktop proof. Managed worktrees, persistent environments, mediated egress and remote hosting remain later slices. Public release approval still requires the applicable CI and packaging proofs; implementation of this gate is not evidence that unrun platforms passed.
