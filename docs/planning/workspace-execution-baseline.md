# Workspace execution PR 0 baseline

Status: PR 0 complete and locally validated. No execution authority or runtime behavior changes in PR 0. The [implementation plan](workspace-execution-implementation-plan.md) and [shared ownership decisions](workspace-execution-ownership-decisions.md) describe future behavior, not guarantees of this revision.

Subsequent PR 1 update: B03 is fixed by common runtime profile/workspace/target validation, and its characterization is now a regression assertion. The PR 0 measurement report remains a historical artifact; the recovery harness now supplies its explicit state home to the validator. Its current digest therefore differs from the recorded PR 0 digest. See the [PR 1 record](workspace-execution-pr1.md).

## Scope and reproducibility

- Base revision: `10d5dbb9c95fcb717ccd84bb927b3c4d045967f5` (updated `main`).
- Branch: `ame/execution-baseline`.
- Runtime/package manager used for the initial baseline: Node `24.14.1`, pnpm `10.33.0`. CI currently uses Node `22.18.0`; local results are not a substitute for that CI lane.
- Installation: frozen root lockfile in a detached checkout of the base revision. The initial sandboxed registry lookup failed; retry with network access succeeded. No dependency or lockfile change is part of this PR.
- The operator checkout contains untracked duplicate-looking source files and planning documents. Keep them untouched. Run validation in an isolated tracked checkout and copy only the explicitly reviewed new test files into it. Never glob-copy the operator checkout or its runtime state.
- No live provider, paid model, channel account, container, or remote environment is used. Later measurements in this PR use deterministic fixtures and real local runtime/tool/store boundaries. Synthetic provider usage must be labeled; it cannot establish real model quality or cost.

## Rollout and authority rules

1. Preserve ordinary current-directory host execution and existing strict/adaptive/open semantics. Named workspaces, managed worktrees, and Docker are optional.
2. Core code owns workspace identities, target records, environment leases, and execution ownership. Desktop consumes them. Source paths and actual working roots are distinct for worktrees/copies.
3. Workspace registry mutation never grants trust. Existing profile config loading remains single-profile; workspace trust does not merge project config.
4. Extend existing scoped approvals. Reuse covered authority, ask for expansion, and preserve the non-overridable hardline floor. Discovery of a tool is not permission to execute it.
5. The existing supervisor will own shared execution. Foreground CLI/ACP can remain daemon-free but must eventually use the same persisted session ownership checks. No second Desktop scheduler or channel poller.
6. An uncertain mutation needs reconciliation before retry. A stored checkpoint, expired lease, cache entry, environment label, or session attachment is not proof of authority or exactly-once execution.
7. PRs 1–4 implement the core identity/authority/host/ownership prerequisites. A small Desktop proof follows before Docker/copy work. Fixing the gaps below is outside this baseline PR.

## Execution and filesystem inventory

This is a migration inventory of current entry points and implementation families, not a claim that a string search proves absence of dynamic execution. Paths are repository-relative. Re-run the searches below when moving each family and inspect registrations, imported wrappers, and failure paths as well as direct calls.

| Family / current entry points | Current execution or state view | Planned consumer / boundary |
|---|---|---|
| `src/runtime/create-runtime.ts`, CLI session loop, `src/acp/server.ts` | Builds tools/providers against a supplied workspace and profile; ACP may overlay editor file operations | Common target resolution and runtime acquisition; explicit editor-buffer materialization |
| `src/gateway/supervisor.ts`, `src/channels/channel-gateway.ts`, `src/runtime/runtime-cache.ts` | Profile supervisor, process-local runtime cache and active-turn registry, startup-captured cached configuration | Shared execution host and owner-fenced session acquisition; current config/trust and cache serialization |
| `src/tasks/agent-step-executor.ts`, `supervisor-task-background-host.ts`, `foreground-task-host.ts`, `task-scheduler.ts` | Task workspace binding, host/attempt leases, foreground/background dispatch | Retain Task leasing; add common executor-session ownership and environment scopes |
| `src/delegation/durable-delegation-service.ts`, `child-runner.ts`, `file-state-tracker.ts` | Durable child Task graphs, ownership heartbeat, shared-workspace conflict tracking | Child scopes and explicit resource sharing; no child authority expansion |
| `src/cron/cron-runner.ts`, `cron-runtime-factory.ts`, `cron-workdir.ts`, `cron-safety.ts` | Scheduled runtime acquisition and optional local script subprocess; execution history and locks | Resolve attached job workspace/authority and move script execution through the selected lease |
| `src/tools/workspace-tools.ts`, `workspace-paths.ts` | Direct Node filesystem reads/search/writes and transactional patch handling; shell execution | Host/Docker file and command lease; preserve containment, patch rollback, and bounded output |
| `src/tools/glob-tools.ts`, `grep-tools.ts`, `terminal-inspect-tool.ts`, `notebook-tools.ts` | Filesystem traversal, subprocess search/inspection, notebook filesystem edits | Same workspace view as file/shell/code execution; inventory fallbacks as well as external binaries |
| `src/context/project-context-loader.ts`, `context-reference-expander.ts`, `context-security.ts` | Host filesystem project instructions and explicit context expansion | Selected target view with instruction provenance/trust; never silently read the source checkout instead |
| `src/tools/execute-code-tool.ts` | Host Python harness plus nested calls into the existing tool executor | Launch harness through lease; preserve nested context/approvals, bound aggregate resources, propagate cancellation |
| `src/process/process-manager.ts`, `src/tools/process-tools.ts`, `src/process/protected-process-transports.ts` | Host subprocess records, logs, stdin and protected environment transports | Scope-owned processes and cleanup; explicit child environment and protected credential transport |
| `src/mcp/mcp-client.ts`, `mcp-tools.ts`, `src/tools/tool-executor.ts` | Configured MCP stdio subprocesses and network transports; executor dispatch | Explicit control-plane capability boundary, not an unrestricted sandbox-to-host escape path |
| `src/browser/` (launcher, CDP client/supervisor, providers, URL policy, lifecycle) | Chrome subprocess, local/CDP and hosted sessions, network/URL checks, profile-local state | Independently gated host/browser capability; honest command-network versus tool-network reporting |
| `src/tools/web-tools.ts`, `web-research-provider.ts`, `web-research-providers/` | Network fetch/search/crawl, provider-specific clients, local DDGS subprocess | Existing egress/URL governance; any workspace outputs use target-aware transfer |
| `src/providers/`, including OAuth and model probes | Network inference and profile credential resolution | Remain in control process; do not inherit provider credentials into worker shells |
| `src/tools/media-tools.ts`, `voice-tools.ts`, `stt-providers.ts`, `tts-providers.ts`, `stt-local-whisper.ts`, `src/cli/voice-mode.ts` | Local audio commands, remote media services, temporary/profile media paths | Explicit capability adapters and owned workers; target files versus profile media state must stay distinct |
| `src/tools/image-generation-tools.ts`, `image-generation-verify.ts`, `vision-tools.ts`, `src/vision/` | Hosted image processing/generation and local source normalization | Preserve provenance/egress checks and profile caches; resolve workspace sources through target boundary |
| `src/python-env/manager.ts`, `capability-manager.ts`, `src/workers/python-worker.ts`, `src/tools/python-tools.ts` | Managed interpreter/package capability installation and workers | Operator-owned capability management stays outside workspace lease; worker execution explicitly bound |
| `src/channels/` adapters, WhatsApp bridge lifecycle/client, `scripts/whatsapp-bridge/` | Remote inputs/delivery, media filesystem operations, subprocess/network bridges | Gateway authentication/session/approval ownership; constrained attachments and profile state |
| `src/artifacts/artifact-store.ts`, `src/tasks/task-result-service.ts`, `task-artifact-content.ts`, `task-result-tools.ts` | Session artifact retention/hydration and Task result content with ownership checks | Extend existing stores for target/source provenance and copy-application artifacts |
| `src/memory/`, `src/session/`, `src/skills/`, `src/packs/`, `src/evolution/`, knowledge/memory/skill tools | Profile/global durable context and optional external services; Evolution constraint commands | Keep management paths separately governed; workspace-specific reads use the selected target |
| `src/setup/`, `src/config/`, config/trust tools and secure-input tools | Reviewed profile writes, trust/grant stores, protected input and credential state | Do not route management writes through arbitrary workspace backends or renderer paths |
| `src/gateway/service-manager.ts`, `service-exec-resolver.ts`, `src/lifecycle/`, install/update scripts | Service/process launch, Git/package operations, startup network checks, managed install paths | Existing operator/install ownership; no automatic fallback or duplicate supervisor |
| `src/doctor/checks/npm-audit.ts`, `src/cli/bench-command.ts`, `src/evolution/constraint-gate-runner.ts` | Diagnostic/package subprocesses, benchmark harness, evaluation commands | Explicit management/evaluation consumers; never reinterpret benchmark labels as verified containment |
| `src/smoke/`, `src/test/`, benchmark fixtures and validation scripts | Test-only subprocesses, fake endpoints, temporary state | Validation support, excluded from production lease migration except where deliberately exercising real code |

Tracked-source discovery recipes (read results; do not use them as a security allowlist):

```bash
git grep -n -E 'node:child_process|Bun.spawn|Deno.Command' -- src ':!*.test.ts'
git grep -n -E 'node:fs|WorkspaceFsAdapter|resolveWorkspacePath' -- src ':!*.test.ts'
git grep -n -E 'fetchLike|fetchJson|fetch\(|WebSocket|node:net|node:http' -- src ':!*.test.ts'
git grep -n -E 'createRuntime|runtimeFactory|createExecutorRuntime' -- src ':!*.test.ts'
```

## Persistence and recovery reuse map

| Existing owner | Preserve / extend for |
|---|---|
| Session DB and profile-filtered session queries | Session ownership metadata, target compatibility snapshots, safe inspection and resume |
| Task store, Task host/attempt leases, graph/session links | Durable work graph and existing fencing; do not create new Run/Step databases |
| `WorkspaceApprovalController` and workspace approval store | Reusable grants with additional scope/generations; existing hardline checks remain first |
| `GatewayApprovalQueue`, `ChannelGateway`, `TaskApprovalService` | Durable pending decisions, authorized resolution and continuation; storage does not become a second orchestrator |
| Pending-turn store and channel-message-turn store | Accepted input, deduplication, claimed/uncertain recovery and attribution |
| Execution checkpoint controller/journal and operation ledger | Dispatched/uncertain mutation receipts and compatible recovery; no general replay guarantee |
| Execution plan/evidence state and Task completion traces | Explain objective/progress/results without treating prose as verified evidence |
| Trajectory recorder, provider usage/spend ledger, benchmark metrics | Definition/authority references and measured calls/tokens/interventions; preserve lineage |
| Session artifact store and Task Results | Existing durable bytes/digests/ownership plus source/target/application provenance |
| Profile/global path helpers, trust and config stores | Preserve intentional global trust and selected-profile state; no project config merging |

## Known gaps to characterize

These are baseline observations or review findings, not desired behavior. Characterization tests must identify them explicitly and be replaced with the intended regression assertion in the fixing PR. Do not make a production change or weaken a safety check to pass PR 0.

| ID | Current observation | Follow-up |
|---|---|---|
| B01 | Concurrent uncached `RuntimeCache.get` calls can build two runtimes and lose one cache-owned cleanup reference | PR 4: serialize acquisition and fence construction/revocation races |
| B02 | Gateway lock acquisition permits age-based reclamation even when the recorded PID is live | PR 4: instance-aware singleton acquisition; expiry alone cannot establish death |
| B03 | At PR 0, resume checked workspace but common runtime construction lacked the equivalent working-root check | Fixed in PR 1: common immutable target/workspace validation; regression assertion replaces gap assertion |
| B04 | Process-local active-turn registries do not coordinate independent processes | PR 4: persisted session owner/fence; retain existing Task leases |
| B05 | Cached gateway factory/fingerprint can retain startup config; MCP exposure uses construction-time trust | PR 4: current acquisition context and appropriate rebuilds; live message trust checks already exist |
| B06 | Background process manager inherits parent env, signals the immediate child on stop, and lacks runtime-wide owned-process disposal | PR 3: explicit environment adapters, scope cleanup and descendant cancellation |
| B07 | Python harness final truncation does not bound accumulated stdout/stderr/tool-call promises; parent cancellation is not wired into harness lifetime | PR 3: bounded lease-backed harness lifecycle |
| B08 | Non-host environment labels influence destructive-local approval without verified backend controls | PR 2: verified authority, not label-derived containment |
| B09 | Existing reusable grant structures do not yet carry the proposed full profile/surface/authority-generation binding | PR 2/5: scoped extension and explicit migration; do not invent legacy authority |

## Measurement protocol

The committed [measurement report](../../evals/baselines/workspace-host.json) records ordinary file-edit completion, authorized channel execution, scheduled work, and interrupted/recovered work. The generator uses `performance.now()` for elapsed times, records setup separately, and preserves every individual sample. Tests assert completed effects and accounting, with no tight wall-clock thresholds.

Provider calls/tokens and approvals must come from observed fixture/runtime accounting, not inferred from elapsed time. Fixed fake-provider token values are accounting fixtures only. No result from the existing scenario harness's injected timestamps may be presented as measured latency. Zero live requests/cost does not imply zero production cost.

Use existing scenario/metrics/trajectory components where they represent the measured boundary. A fake runtime that directly writes the answer is not sufficient evidence of real agent-loop completion. Keep deterministic structural tests separate from timing samples and distinguish simulated recovery from actual host crash recovery.

## Measured host workflows

Run from a clean checkout with the frozen lockfile installed:

```bash
pnpm exec vitest run src/runtime/workspace-execution-baseline.test.ts src/runtime/host-execution-baseline.test.ts
node --import tsx scripts/measure-host-execution-baseline.ts --samples 5 --out evals/baselines/workspace-host.json
```

The [harness](../../src/test/host-execution-baseline.ts) creates fresh temporary workspace/profile/trust/SQLite state for each sample. A scripted provider asks the real agent loop to read and patch `counter.cjs`, then run `node verify.cjs`. The command asserts the edited function's behavior. The provider requires successful tool receipts before continuing; the harness verifies final bytes, one successful patch, one successful command, final response/delivery, no tool failures, and matching provider event/invocation counts. Every runtime and temporary directory is disposed after the sample. No production runtime is replaced with a fake.

The channel case uses real `ChannelGateway` allowlist authorization and adaptive policy with a fake Telegram delivery adapter. The scheduled case uses `createRuntimeCronRunner`, including trusted workdir resolution and delivery, without a daemon, scheduler tick, or scheduling wait. The recovery case cooperatively aborts after the successful patch, disposes the runtime, reopens SQLite, validates session/profile/workspace compatibility, reads the existing edit and verifies it. The original user message survives reopening; six messages are present before resume in every recorded sample. This does **not** measure a killed process, cancellation of an in-flight subprocess, cross-process fencing, uncertain mutation reconciliation, or crash recovery of durable Tasks.

Results from five samples per scenario on Darwin/arm64, Node 24.14.1, pnpm 10.33.0, Vitest 4.1.6:

| Workflow | Completed | Median execution ms | Median runtime acquisition ms | Median command ms | Provider calls/sample | Synthetic total tokens/sample | Approval prompts/sample |
|---|---:|---:|---:|---:|---:|---:|---:|
| Code edit | 5/5 | 342.5 | 12.4 | 320.2 | 4 | 440 | 0 |
| Authorized channel | 5/5 | 341.2 | 12.0 | 320.3 | 4 | 440 | 0 |
| Scheduled runtime | 5/5 | 337.7 | 11.9 | 315.3 | 4 | 440 | 0 |
| Interrupted/resumed session | 5/5 | 362.2 | 12.4 | 319.1 | 5 | 550 | 0 |

Recovery median is 341.2 ms, including disposal, SQLite reopening, new runtime acquisition, reread and verification. The recovery acquisition column aggregates both acquisitions per sample. Command timings span runtime tool-start/tool-result events, including policy/executor and subprocess overhead. Execution includes runtime acquisition, tools, and delivery; fixture setup and final cleanup are excluded. Imports/JIT and OS caches warm across the run; these are not fresh-process CLI startup measurements. Do not add the overlapping timing columns.

The provider returns exactly 100 input / 10 output tokens per successful call to exercise existing usage accounting. Calls are observed and tokens are synthetic; live-provider requests are zero and estimated production cost is unavailable. Zero approval prompts characterizes these narrow trusted adaptive-mode fixtures only; it says nothing about strict mode or destructive/remote actions. Small local samples provide a comparison point for future host changes, not a percentile SLA or a model-quality/completion-rate estimate. No regression budget is set yet.

The report records the production base revision plus SHA-256 digests of the harness, generator and frozen lockfile, and machine/runtime metadata without user paths, environment values or transcript contents. It was generated from the isolated base checkout with the reviewed new fixture files copied in. A failing fixture exits nonzero before replacing an existing report. Run focused tests for diagnostic detail; never publish a previous report as the result of a failed new run.

## Validation and commit review ledger

The standard validation commands are those in `AGENTS.md`. Record actual outcomes after execution. A full pass on this machine does not prove Docker containment, live provider completion, channel-account delivery, shared-process ownership, or future Desktop lifecycle behavior.

1. Documentation commit: plans and ownership decisions preserved; inventory mapped to current source. Review checks: local Markdown links, whitespace, and no runtime/source mutation.
2. Characterization commit: `src/runtime/workspace-execution-baseline.test.ts` adds 11 passing tests for canonical identity/trust separation, persisted resume isolation, once/session/persistent approval reuse and expansion, hardline precedence, and observed gaps B01–B04/B08. B04 uses independent registry instances; it does not claim to implement or validate a cross-process lease. Focused tests and typecheck passed in the isolated checkout. Review: all real state is temporary, cache runtimes are inert fakes, policy probes never execute their command strings, and no production source changes are included. Gap assertions intentionally describe the old behavior and must be replaced when the corresponding fix ships.
3. Measurement commit: four real-runtime workflow tests pass, and the generator completed 20/20 measured samples. Review checked schema-correct tool calls, real verification effects, final delivery, temporary-state cleanup, cancellation ordering, persisted session reuse, usage accounting, monotonic timing, and report/source digests. No runtime policy, dependency, lockfile or production source changes. Full local validation passed as recorded below.

| Check | Clean base | Base plus PR 0 fixtures |
|---|---|---|
| Node / pnpm versions | 24.14.1 / 10.33.0 | Same |
| `pnpm install --frozen-lockfile` | Passed with network access | Same unchanged installed lockfile; no reinstall needed |
| `pnpm run typecheck` | Passed | Passed |
| `pnpm run test` | 10,384 tests / 579 files passed | 10,399 tests / 581 files passed |
| `pnpm run smoke` | Passed | Passed |
| `pnpm run build` | Passed | Passed |
| `pnpm run audit:runtime-imports` | Passed | Passed |
| `pnpm run audit:esm` | Passed | Passed |
| `pnpm run smoke:dist` | Passed | Passed |
| `git diff --check` | Passed | Passed; new files also checked before commit |

Focused validation: 15/15 tests across both new test files. The full suite used a clean detached checkout with only the reviewed fixture files added; unrelated operator files were excluded. Local test and measurement runners removed secret-named environment variables and used `CI=true`. CI's Node 22.18.0 lane and other operating systems were not run locally. Known gaps B01–B09 remain follow-up work, not failures of these documented baseline acceptance criteria.

Security note: this PR documents sensitive boundaries and adds isolated local test/measurement consumers. It grants no new execution authority, changes no persisted production schema, installs no capability/service, and makes no production credential request. Runtime fixes and migration/downgrade decisions remain in subsequent PRs.
