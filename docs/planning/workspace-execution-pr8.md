# PR8 — Host and Docker release hardening

Status: implemented and locally validated in the seven prescribed commits on `ame/execution-baseline`. See [release workflows, budgets and threat model](../operations/execution-release.md). This slice consolidates the core release contract; packaged Desktop and Windows transport remain separate delivery gates.

## Commit reviews

1. `dcaf26fc` — Read-only doctor execution readiness with current trust, host controls, selected Docker image/engine inspection, Arabic copy, actionable blockers and redacted failures. No container acquisition or grant creation. Typecheck and 9 focused tests passed.
2. `edb499ba` — Human application summaries for runtime and workspace commands, isolated Arabic identifiers, safe artifact IDs and explicit `--json` detail output. Typecheck and 12 focused tests passed.
3. `deaf9cd7` — Fixed-size cumulative trajectory metrics and hashed execution references, reusing the checkpoint definition/authority calculation. Reports distinguish dispatched attempts and absent usage; compression preserves observations. Typecheck and 23 focused tests passed.
4. `1ce982fa` — Required core conformance runner selecting ownership, surface, environment and application suites; missing files fail closed. All 295 tests in its initial 34 files passed.
5. `a6342536` — Repeated owner succession and stale settlement, simultaneous child-scope cancellation, revoke/regrant after export, and source-symlink replacement. Typecheck and 10 focused tests passed. Expanded the conformance selection to include these tests and approval regression suites.
6. `5d5b8a1e` — `smoke(execution): add required backend lifecycle validation` — Full release wrapper, CI wiring, source/compiled Docker gate, measured host budgets and Docker acquisition/read budgets. Review corrected the supervisor test's startup barrier: signal-handler installation does not establish that the gateway has started. Review also ensures a failed cold-acquisition timing budget settles the newly prepared environment and each timed warm read actually compares 8 MiB. Final persistence review found that SQLite stores trajectory events rather than arbitrary top-level fields; bounded observations now round-trip through one replaceable event in that existing store. Typecheck and 27 persistence/metrics tests passed.
7. `docs(execution): publish implemented workflows migration and threat model` — Operator workflow, compatibility, metrics semantics, release matrix, measured comparison, risk notes and platform limitations.

## Core conformance mapping

The executable selection is `scripts/validate-execution-conformance.mjs`; the full release wrapper runs the complete suite plus real Docker and package-image gates.

| Shared case | Current evidence / boundary |
| --- | --- |
| 1: singleton, stale timestamp, sleep/PID evidence | Shared-host startup, workspace baseline and execution-ownership tests reject expiry-only takeover and unknown/reused live-owner evidence. Actual machine sleep is not simulated as a guarantee of availability. |
| 2–3: serialized clients and foreground/shared races | Shared-session host, control receipts, independent-process Session ownership, runtime cache and workspace concurrency tests. Separate Sessions retain independent claims. Desktop windows are not implemented consumers in this repository slice. |
| 4–5: attachment, profile/surface isolation | CLI handoff, ACP ownership/approval, channel workspace selection, recurring authority and Session binding tests. Packaged Desktop close/reopen/profile-switch remains a Desktop proof. |
| 6–7: crash, lost reply, stale settlement | Control acceptance/deduplication/recovery, real process exits during copy mutation, independent-process ownership recovery, late-write fences and repeated succession tests. No blind replay claim. |
| 8: aliases, replacement, content parity | Workspace identity/concurrency, copy provenance/security, source replacement and host/Docker file/code/command parity. Managed Git worktree lifecycle is outside this slice. |
| 9: acquisition failure and borrower cleanup | Host environment/process/bounds tests, Task handoff, cache cleanup, Docker receipts and stress tests. Real Docker validates owned cancellation and surviving child scope. |
| 10: bounded priority control | Private-control and shared-session tests cover bounded frames, pending response behavior and priority cancellation. They do not establish a Desktop notification-queue implementation. |
| 11: ACP/foreground content | ACP server/ownership, host editor parity and Task foreground handoff exercise selected workspace and explicit save/materialization semantics. Live foreground resource transfer is unsupported. |
| 12: restart and compatibility | Core receipt, registry/version, Session ownership and private transport checks; package-image version/help startup. Signed Desktop relaunch and cross-binary Desktop compatibility remain separate gates. |

## Measured comparison with PR0

The [PR8 report](../../evals/baselines/workspace-host-pr8.json) was generated from revision `5d5b8a1e` with the existing harness and five fresh-state samples per scenario. It retains source/harness/lockfile digests, platform information and all samples. The seventh commit contains the measurement report and documentation only. PR0 remains unchanged at [its original report](../../evals/baselines/workspace-host.json).

| Scenario | Completed PR0 / PR8 | Median execution ms PR0 / PR8 | Median startup ms PR0 / PR8 | Provider calls PR0 / PR8 | Approval requests |
| --- | --- | --- | --- | --- | --- |
| Coding | 5/5 / 5/5 | 342.5 / 83.3 | 12.4 / 22.9 | 4 / 4 | 0 / 0 |
| Authorized channel | 5/5 / 5/5 | 341.2 / 84.9 | 12.0 / 22.4 | 4 / 4 | 0 / 0 |
| Scheduled work | 5/5 / 5/5 | 337.7 / 100.9 | 11.9 / 22.5 | 4 / 4 | 0 / 0 |
| Interrupted/resumed | 5/5 / 5/5 | 362.2 / 135.3 | 12.4 / 21.8 | 5 / 5 | 0 / 0 |

Median command latency was approximately 315–320 ms at PR0 and 31–32 ms at PR8. Median cooperative recovery was 341.2 ms at PR0 and 85.0 ms at PR8.

Synthetic token counts are unchanged (440 per ordinary sample; 550 per recovery sample). Startup increased by approximately 9–11 ms across this workstream; this comparison does not isolate individual causes. Scenario medians decreased, but these small local runs on different dates do not isolate the cause or establish production speedup. The recovery fixture is cooperative abort/resume; separate crash tests establish guarded file recovery. No live provider calls, model-quality measurement or billable-cost claim is made.

Reviewed gate budgets require all samples to complete with zero approval prompts and no provider-call/token increase over PR0. Median host startup/execution ceilings are 1,000/2,000 ms to catch material failures while allowing CI variability. Docker cold/warm ceilings are 60 seconds/30 seconds for the specified fixture. These are explicit acceptance ceilings, not percentile or hosting promises.

## Final validation

Validation used Node 24.14.1 and pnpm 10.33.0 in the isolated tracked checkout, keeping unrelated untracked operator files untouched. No dependency or lockfile changes.

- Required release wrapper passed: frozen installation, typecheck, 10,605 tests across 633 files, all 13 source smoke cases, production build, runtime-import and ESM audits, and all 13 distribution smoke cases.
- All 12 measured budget samples passed (three per scenario), with zero approvals and PR0 provider-call/synthetic-token ceilings preserved. The final committed measurement artifact independently records 20/20 successful samples against `5d5b8a1e`.
- Real Docker source and compiled gates passed, including file/code/process/network/lifecycle controls, copy application, guarded rollback and settled owned receipts. Cold container acquisition measured 210–285 ms; three warm 8 MiB reads measured 1,101 ms for source and 1,085 ms for compiled execution, with zero new containers during warm reads.
- Existing package-image validation passed its Node 22.18.0 build and `--version`/`--help` startup checks. This does not substitute for the complete Linux/Node 22 CI test lane.
- The final 38-file conformance manifest check, script syntax checks, documentation relative links and `git diff --check` passed. The manifest/hygiene prechecks added to the wrapper were also verified independently.

The initial full run exposed one graceful-drain test startup race (10,603 passed, one failed). The isolated supervisor suite passed all 89 tests; review then corrected the test to wait for gateway start before signalling shutdown. Subsequent full runs passed. The later SQLite persistence correction passed 27 focused tests and the complete final release wrapper above.

## Security and remaining delivery risks

PR8 changes diagnostics and presentation, adds observational fields and required validation, and does not grant new execution authority. Doctor cannot provision images or approve work. Summaries exclude raw file paths/errors; detailed JSON remains an explicit local operator surface. Metrics/references cannot authorize recovery, cross profiles or promote learned behavior. Core trust, hardline rules, grant generation and owner fences remain enforced.

Same-user host processes, the local operator, kernel, runtime and approved Docker daemon/image remain trusted. This release does not provide hostile multi-tenant isolation, aggregate quotas, universal rollback or power-loss atomicity. Temporary-copy automatic application remains local foreground CLI only, and active child work defers it. Existing migration/downgrade constraints remain in force; additive trajectory fields require no database version change.

CI's Node 22/Linux result and packaged Desktop lifecycle were not run locally. The conformance mapping identifies those delivery boundaries explicitly instead of claiming that core fixtures test an absent application. No remote backend, Desktop execution database, second scheduler, trace-to-eval automation or implicit Evolution promotion was introduced.

## PR7/PR8 review follow-up

A focused follow-up fixes the review findings without changing execution authority:

- Used copies return attention instead of presenting an old applied receipt as success for new edits. Explicit artifact retries retain idempotency.
- Local copy finishing runs before canonical completion is persisted, including final outcome, transcript, checkpoint settlement and trajectory. Returned and persisted partial outcomes agree.
- Trajectory accounting includes provider continuations and records approval asks before the handler resolves them. The four-call coding fixture records four dispatches and 440 synthetic tokens.
- The integration gate also exposed a definition-hash format mismatch that discarded real runtime references. SHA-256 references now cover the final filtered registry and survive SQLite persistence; checkpoint hydration uses the same final definition.
- Docker doctor shares static control negotiation with acquisition, blocking impossible mandatory controls and explaining advisory defaults before execution.
- Required source/compiled Docker gates now exercise configured production runtime acquisition through CLI, real gateway authorization and repeated scheduled jobs. They verify command containment, durable authority, metrics, missing-image failure and owned container/sidecar disposal.

The historical PR8 measurement report above remains unchanged. Its benchmark event accounting already included all fixture provider calls; it is distinct from the corrected trajectory counters. Desktop, Windows transport, full Linux CI and hostile multi-tenant isolation remain separate boundaries.

Follow-up validation: the complete required release wrapper passed on Node 24.14.1 / pnpm 10.33.0: frozen install, typecheck, 10,611 tests in 633 files, both 13-case smoke suites, build, import/ESM audits, all host budget samples, expanded source/compiled Docker workflows and package-image build/startup. The conformance manifest now includes 40 required files. Documentation links, patch hygiene and byte comparison with the isolated validation checkout passed; unrelated operator files were excluded from that checkout and preserved.

Security review: finalization still requires the original local foreground scope, settled child/process work, current owner, trust, grants, source baseline and containment. Diagnostics and definition references confer no authority. No new dependencies, automatic image acquisition, remote application authority or recovery guarantees were introduced.

## Live-validation follow-up

The Kimi read/edit/test probe exposed a provider-visibility gap: repository inspection took precedence over an explicit edit, and the scripted workflow providers could request tools absent from their offered schemas. Repository edits and explicit local test commands now select the existing repository modification policy ahead of inspection. Quoted examples and negated action clauses do not supply that intent. Host baseline, copy acceptance and source/compiled Docker workflow fixtures now require each requested provider alias to be advertised and exercise that alias through the real runtime.

Risk review: this changes capability discovery, not execution authority. Workspace trust, tool policy, approval and hardline checks still run at execution. POSIX cleanup now gives a failed signal a bounded opportunity to obtain OS proof of group absence and allows later cleanup retries; denied probes and surviving groups retain ownership. A retry after the leader closes never signals its stale PID. This handles a supported signal/exit race without claiming the earlier intermittent macOS failure was conclusively reproduced or that Windows descendant behavior was validated.

The live-validation review identified a separate completion-classification edge case: a read request followed by “Do not modify the code and add tests” can receive a mutation completion floor and be reported as partial. The first follow-up kept those negated edits out of the offered policy but left the completion-floor heuristic unchanged; the completion-labeling correction below resolves it.

Full-suite validation also reproduced the supervisor fixture's one-second readiness timeout (different startup tests, followed by unfinished-fixture interference). The test helper now permits three seconds for real profile/SQLite startup; all readiness, drain and ownership assertions remain intact. The isolated 89-test supervisor suite passed before this adjustment, so this is a test scheduling allowance rather than a production lifecycle policy change.

Validation: the complete release wrapper passed, including frozen installation, all smoke/build/import checks, host workflow budgets, source/compiled Docker workflows and packaged Docker startup. After the final polling-timer and supervisor-fixture refinements, typecheck, all 10,635 tests in 633 files, build, runtime-import/ESM audits and all 403 conformance tests in 40 files passed. The standalone cleanup suite passed 9 tests and the previously intermittent descendant case passed ten repetitions. Live Kimi (`kimi/kimi-k3`) completed host application and Docker review-only workflows with the unchanged prompt: nine HTTP 200 requests, matching completed persisted outcomes, unchanged test files and zero remaining Docker receipts. Docker ran the same test twice; these two samples do not establish model-efficiency or reliability rates.

## Completion-labeling correction

Completion expectations now scope negated edit clauses before punctuation and contractions are flattened, using the same sentence/contrast boundaries as repository routing. A request to read a file followed by “Do not modify the code and add tests” retains its read floor. A successful read can complete it; a provider response without read evidence remains blocked. Quoted examples do not supply requested edits, and genuine edits alongside constraints still retain their mutation and configured verification requirements. Arabic combining marks remain intact during expectation normalization.

Risk review: this changes the requested-mutation heuristic, not receipt settlement, source-application authority, workspace trust or tool approval. Real-runtime tests check returned, event and trajectory outcomes, unchanged source bytes, unavailable edit schemas, and consumed-copy attention after a read-only turn.

A live Kimi replay then exposed another label-only cause: its completed read response ended with an optional offer (“If you actually meant … just say the word and I’ll add a test file”), which the continuation detector treated as unfinished work. User-choice offers are now distinguished from actual promises within their sentence. Real commitments, environmental conditions and approval-dependent work remain open, and regression tests verify that they still prevent a completed label.

Validation: the full release wrapper passed, including frozen installation, smoke checks, host budgets, source/compiled Docker workflows and packaged Docker startup. Final review then verified that an optional offer cannot hide a real promise in the same response: all 10,671 tests in 633 files, all 409 conformance tests in 40 files, typecheck, build and runtime-import/ESM audits passed. The exact read-only prompt also passed live on host and Docker with `kimi/kimi-k3`: each backend performed one successful file read, left the source unchanged, and returned/persisted `completed` with a `read` floor. Four provider requests returned HTTP 200; disposal left no Docker receipts. These remain bounded acceptance samples.
