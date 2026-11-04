EstaCoda has implemented durability, approval, budget, and learning gates. Two bounded offline test runs passed 249 tests; no live-model or deployment claims are established.

## Scope and repository identity

Assigned scope: **EstaCoda runtime**, excluding `upstream/`. I inspected root `package.json`, Vitest/TypeScript configuration, relevant production source and existing deterministic tests. No implementation edits, installation, secrets access, deployment, or external-service calls were performed.

Observed commands:

```sh
git rev-parse HEAD
git status --short
git diff --stat
git log -1 --format='%H %s'
```

Results:

- **HEAD:** `9a8d571ef7455b612c7d37607eaa8570af3dfd31`
- Commit subject: `Pinned benchmark subject snapshot`
- `git diff --stat`: empty.
- Working tree status, both initially and after tests:

```text
?? UPSTREAM.json
?? node_modules
?? upstream/
```

Thus tracked files were unchanged relative to this snapshot commit, but **the overall working tree was not clean**. The MANIFEST baseline `bed689970f442caa9cf44432eeeec30bed9f05de` supplied in the delegation context is **not** the actual checkout HEAD and must not be presented as its exact identity.

Environment observed:

- Node `v24.14.1`
- Vitest `4.1.6`, `darwin-arm64`
- Existing `node_modules/.bin/vitest` was usable.
- `package.json` declares Node `>=22.18.0`, `pnpm@10.33.0`, and Vitest `^4.1.5`; installed version was the version above.
- `vitest.node.config.ts` uses Node, includes `src/**/*.test.ts`, and sets up `src/test/vitest-setup.ts`.
- Setup invokes `installIsolatedStateHome()`; `src/test/state-home.ts` creates a temporary HOME.
- No missing prerequisite blocked the selected tests. This is not evidence that Docker, Chrome, ffmpeg, external providers, or all packaging prerequisites are ready.

## Bottom line for synthesis

EstaCoda is **not merely a prompt bundle**: the inspected source implements a bounded provider/tool loop, dispatch-time authorization, SQLite-backed task orchestration, lease/fencing recovery, result integrity/access checks, durable provider-spend reservations, and governed skill updates.

The strongest evidence here is operational invariants demonstrated by deterministic tests—not comparative coding performance. A fair comparison should map the **complete superagent + Harness stack** onto these mechanisms rather than compare the superagent bundle alone with all of EstaCoda.

I did not inspect the external stack in this assignment, verify its URL, or establish its launch/latest status. Those findings must come from the other research evidence.

## Source-backed capability findings

### 1. Agent loop and tool execution

**Implemented source:**

- `src/runtime/provider-turn-loop.ts:124–132`, `ProviderTurnLoopBudgets`: explicit iteration, tool-call, repeated-failure, repeated-browser-observation, no-progress, wall-clock, and finalization-reserve budgets.
- `src/runtime/provider-turn-loop.ts:204`, `ProviderTurnLoop`.
- `src/runtime/provider-turn-loop.ts:452`: bounded provider iteration loop.
- `src/runtime/provider-turn-loop.ts:469–497`: wall-clock/finalization reserve and tool-call budget stops.
- `src/runtime/provider-turn-loop.ts:777`: completion repair cannot simply retry an earlier refused tool.
- `src/runtime/provider-turn-loop.ts:907–916`: execution supervision assesses progress and checks remaining iteration/tool-call capacity.
- `src/tools/tool-executor.ts:169`, `ToolExecutor`; `:234`, `executeTool`; `:643`, dispatch authorization validation.

**Interpretation:** production runtime source, not just an architectural aspiration. Its actual model performance, latency, and quality under long coding tasks remain unmeasured here.

### 2. Security and approval

- `src/security/dispatch-authorization.ts`, `withDispatchAuthorization` and `validateDispatchAuthorization`: process-local capabilities retained in WeakMaps, intentionally excluded from serialized/model-visible records.
- `src/tools/tool-executor.ts:415–451`: tool approval request, exact-tool-call authorization failure, cancellation, and operator-denial branches.
- `src/tools/tool-executor.ts:643`: authorization validation immediately before dispatch.
- Executed `src/security/dispatch-authorization.test.ts`: assessed grants are fenced across revoke/identical regrant; unrelated changes preserve covered grants while relevant revocation invalidates them.
- Executed `src/security/pending-action-approval.test.ts`: action/process/session/authority generation/expiry binding; argument canonicalization preserves significant distinctions.

**Tradeoff:** approval provenance and revocation are stronger evidence than a generic “has approvals” label. They are not a universal sandbox guarantee. Host execution versus Docker isolation must be compared separately; I did not run Docker or inspect all escape boundaries.

### 3. Durable tasks, delegation, concurrency, and recovery

- `src/tasks/task-scheduler.ts:196`, `TaskScheduler`; `:246`, `runOnce`.
- `src/tasks/task-scheduler.ts:387–415`: bounded settlement/drain and interruption during handoff.
- `src/tasks/task-scheduler.ts:537–603`: lease heartbeat, rejected-renewal handling, abort on lease loss.
- `src/tasks/task-scheduler.ts:836–901`, `#recoverAbandonedAttempt`: checks lease expiry, reconciles terminal tasks, records interrupted/expired attempts, and marks potential side effects uncertain before failure policy.
- `src/delegation/durable-delegation-service.ts`, `DurableDelegationService.create` / `createAndActivate`: inspected production service and associated existing tests.

Executed delegation tests cover:

- Immutable fan-out graph with terminal synthesis.
- Workers before synthesis and preservation across restart.
- Partial synthesis after another worker fails.
- Refusal to synthesize when no worker publishes accepted evidence.
- Fail-closed child access admission.
- Idempotent provider-call replay versus changed immutable definitions.
- Parent lease ownership and expiry checks.
- Child authority/budget narrowing.
- Atomic competing child reservations.
- Ancestor concurrency and deadline enforcement.
- Post-commit activation failure returning a durable handle with redacted diagnostic marker.

Precise existing test anchors include:

- `src/delegation/durable-delegation-service.test.ts:237`, access unavailable before persistence.
- `:601`, immutable fan-out/synthesis.
- `:674`, restart preservation.
- `:741`, no accepted evidence.
- `:889–923`, missing/cancelled/expired/stale parent lease.
- `:967`, repeated children cannot multiply parent ceiling.
- `:1048`, competing reservations.
- `:1167`, child cannot expand root live concurrency.
- `:1200`, ancestor wall-clock expiry.
- `:1251`, active descendant abort at ancestor deadline.

**Important tradeoff:** source recovery explicitly represents uncertain side effects; it should not be described as “exactly-once external execution.” Safe replay versus operator review is the meaningful distinction.

### 4. Results are durable, access-controlled objects—not just chat text

- `src/tasks/task-result-service.ts`, `TaskResultService`.
- `:489`, bounded `preview`; `:498`, `readPage`; `:529`, `readText`.
- `:532–536`: session authorization, task/result association, available-status checks.
- `:592–607`: integrity failure paths, changed-during-read checks, symlink and hash validation.
- `:636`, `#isSessionAuthorized`.

Executed tests include Unicode-safe paging after restart, rejected cross-profile service binding, preparation recovery, tampering detection, symlink rejection, pruning/no resurrection, and expiry retention checks.

### 5. Provider budgets and cost accounting

- `src/tasks/sqlite-provider-spend.ts:66`, `SQLiteProviderSpendController`.
- `:105`, `reserve`; `:277`, `settle`; `:331`, `recoverExpired`; `:336`, `markUncertain`.
- `:25`: explicit `dispatch-outcome-unknown-after-recovery` uncertainty reason.
- `:546–599`: synthesis earmarks inside applicable monetary scopes.
- `src/providers/provider-executor.ts`, `ProviderExecutor.complete`, `#authorizeProviderSpend`, and reservation/settlement integration inspected.
- `src/providers/provider-spend-policy.test.ts`: unknown or dimensionless multimodal input bounds fail closed, explicitly zero-cost local vision remains usable, output-bound metadata handling.

Executed tests establish:

- Durable dispatch marking before adapter entry.
- Settlement into task/session scopes.
- Retry cost rechecks.
- Concurrent reservation preventing oversubscription.
- Fail-closed attributed execution without spend controller.
- Settlement failure strips executable tool calls, preserving only diagnostic text.
- Uncertain dispatched reservations remain held.
- Lease expiry/recovery fencing.
- Synthesis capacity protection.
- Cross-process spending safety.

**Qualification:** these are **estimated monetary accounting controls**, not verification against actual provider invoices. Passing deterministic accounting tests does not establish live provider routing, deployed pricing freshness, or bill reconciliation.

### 6. Memory and skills evolution

- `src/evolution/candidate-lifecycle.ts`, `canTransition`: explicit approval required before generic manifest promotion; rollback only after promotion.
- `src/evolution/constraint-gate-runner.ts`, `ALLOWED_GATES` / `runConstraintGates`: only allowlisted argv-based gate commands; rejects unknown commands before spawning.
- `src/skills/skill-proposal-service.ts:249–355`: profile write lock; proposal kind/status checks; automatic-policy, source-trust, low-risk and text-patch restrictions; evidence/trust checks; task-evaluation validation; base-content hash checks; local mutable skill restriction; skill eval gate; authority revalidation; instruction-only automatic patch restriction; snapshot before write.
- `src/skills/skill-proposal-service.ts:226`: failed/tied task evaluations persisted so old passing evaluations cannot remain promotable.
- `src/skills/skill-proposal-service.ts:383+`: rollback eligibility/review source exists.

Executed:

- `src/evolution/candidate-lifecycle.test.ts`: direct proposed/testing → promoted rejected; invalid approval/rollback rejected.
- `src/evolution/constraint-gate-runner.test.ts`: disallowed commands rejected before spawn, timeout behavior, aliases, sequential execution.
- `src/skills/skill-proposal-service.test.ts:184–214`: disabled proposal policy, autonomy none, shadow-only autonomous proposal metadata.
- `src/memory/memory-hardening-evals.test.ts`: forgotten preferences not injected; profile/workspace scoping; additional existing hardening cases.

**Qualification:** do not call this unrestricted self-improvement. Nor should synthesis say every mutation always needs a human: the inspected skill path deliberately permits a narrowly gated automatic instruction-only update mode.

### 7. MCP, browser, media, interfaces

**MCP source implementation verified:**

- `src/mcp/mcp-client.ts:134–161`: stdio/HTTP startup prerequisites, initialization, negotiated capability storage.
- `:165–190`: tool listing/calling, resources listing/reading, prompt listing.
- This is client implementation evidence, **not proof any MCP server is configured/live**.

**Browser source and offline acceptance evidence:**

- `src/browser/browser-backend.ts`, `createUnconfiguredBrowserBackend` and mock backend inspected.
- `src/runtime/create-runtime.ts` imports `createSupervisedLocalCdpBrowserBackend` and accepts a browser backend.
- Executed protected-auth acceptance uses `FakeCdpAuthPortalSocket`, fake CDP fetch, and fake provider registry, not real credentials or a public login.
- It covers password/OTP journeys, cancellation, changed submission conditions, failed preflight/recovery, and browser closure scenarios.

**Media:**

- `src/tools/media-tools.ts:22–60`, `createMediaTools`: bounded local command probing, `media.probe-ffmpeg`, explicit ffmpeg/ffprobe availability reporting.
- Media tools additionally have workspace/allowed-root path handling and bounded command helpers.
- **No live ffmpeg or media-production run was executed.**

Channel/UI source trees contain multiple adapters and desktop/control surfaces, but I did not conduct a full end-to-end interface benchmark. Do not equate presence with working configured accounts or packaged desktop availability.

## Exact deterministic test receipts

### Run A: security, auth, recovery, budgets, lifecycle

Inspected scripts/config and selected test bodies before execution. A verbose initial execution succeeded, but output was truncated, so I repeated with the dot reporter to obtain an unambiguous bounded receipt. **Do not count that repeated execution as additional unique coverage.**

Exact receipt-producing command:

```sh
node_modules/.bin/vitest run --config vitest.node.config.ts --reporter=dot src/security/dispatch-authorization.test.ts src/security/pending-action-approval.test.ts src/runtime/protected-authentication.acceptance.test.ts src/runtime/execution-checkpoint-journal.test.ts src/tasks/task-scheduler.test.ts src/tasks/task-result-service.test.ts src/providers/provider-spend-enforcement.test.ts src/providers/provider-spend-policy.test.ts src/tasks/sqlite-provider-spend.test.ts src/evolution/candidate-lifecycle.test.ts src/evolution/constraint-gate-runner.test.ts > /tmp/estacoda-runtime-test-receipt.txt 2>&1; result=$?; tail -35 /tmp/estacoda-runtime-test-receipt.txt; echo EXACT_EXIT_STATUS=$result; exit $result
```

Receipt:

```text
Test Files  11 passed (11)
Tests       164 passed (164)
Duration    7.51s
EXACT_EXIT_STATUS=0
```

Failures: **0**. Selected files: **11**.

### Run B: learning, memory, delegation, cross-process spend, completion repair

```sh
node_modules/.bin/vitest run --config vitest.node.config.ts --reporter=dot src/memory/memory-hardening-evals.test.ts src/skills/skill-proposal-service.test.ts src/delegation/durable-delegation-service.test.ts src/tasks/provider-spend-cross-process.test.ts src/benchmark/completion-recovery.test.ts > /tmp/estacoda-runtime-test-receipt-2.txt 2>&1; result=$?; tail -65 /tmp/estacoda-runtime-test-receipt-2.txt; echo EXACT_EXIT_STATUS=$result; exit $result
```

Receipt:

```text
Test Files  5 passed (5)
Tests       85 passed (85)
Duration    4.42s
EXACT_EXIT_STATUS=0
```

Failures: **0**. Selected files: **5**.

`src/benchmark/completion-recovery.test.ts` runs the production runtime with an offline provider fixture and temporary workspace. Scenarios include renamed, crashed, denied, and unrepaired verification checks; these test completion discipline, not model intelligence.

**Combined unique selected coverage: 16 files, 249 passed tests, 0 failed.** Neither a full-suite result nor a comparative coding score.

## Evidence-supported recommendations for synthesis

1. **Benchmark the whole external runtime stack.** Compare its scheduling, recovery, sandboxing, and accounting with EstaCoda—not only skill instructions.
2. **Run matched-model/task/budget experiments before any coding-quality ranking.** Include repair rate, hidden-test success, tool failures, total tokens, actual/estimated spend, time, and human interventions.
3. **Add adversarial end-to-end scenarios across existing boundaries.** EstaCoda has granular gate tests; measure combined provider failure + scheduler restart + revoked authority + partial result recovery.
4. **Surface uncertainty rather than flattening it.** Recovery deliberately retains uncertain spend and side effects; UI/operator workflows should make reconciliation and review obvious.
5. **Keep capability/readiness evidence separate.** Source supports MCP/browser/media, but selected tests do not prove installed external dependencies, configured servers, valid credentials, or deployment.
6. **Evaluate learned-skill gains independently.** Gated proposal safety is implemented, but this investigation does not show that learned skills improve real coding outcomes without regressions.

## Limits and handoff

- No live web-source verification performed in this scope.
- No live provider/model run; no claim about current configured execution or last provider record.
- No installation or external services.
- No Docker/Chrome/media/packaging smoke run; not blocked attempts, simply outside selected bounded deterministic checks.
- No full test suite or global typecheck.
- No comparative coding-performance measurement.
- No report file written by this worker, as instructed. Synthesis must write and read back `benchmark-superagent-vs-estacoda.md` itself if delivering that artifact.
