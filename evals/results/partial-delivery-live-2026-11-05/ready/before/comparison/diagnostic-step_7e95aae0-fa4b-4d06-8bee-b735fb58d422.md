EstaCoda’s fixture passed 256 focused tests covering recovery, delegation, controls, and learning. These are deterministic runtime checks, not live-model or deployment benchmarks.

## Scope and provenance

- Inspected **only EstaCoda workspace source**, not `upstream/`.
- Read root `AGENTS.md`. It explicitly identifies these as **source research fixtures, not deployed services**, and prohibits inferring comparative live-model coding performance from native test counts (`AGENTS.md:1–2`).
- Independently observed workspace Git HEAD:
  `74fef097458dca3b104be11bc8a48b338a444cab`.
- `MANIFEST.json:2–19` declares baseline `65cef7f154d721ad73a779efaf2066b1d99bd488` and updated source hashes. Findings below concern the inspected fixture, **not an assertion about baseline behavior or currently deployed EstaCoda**.
- Important manifest discrepancy: `MANIFEST.json:18` lists `src/runtime/recoverable-draft.ts`, but an attempted read/search reported that path absent. Recovery code does exist elsewhere, as described below; I did not establish why that listed file is absent or validate all manifest hashes.
- No network calls, credential access, `.env` reads, or source edits were performed. Test execution created isolated test state, not intended source changes.

## Executed test benchmark

### Configuration inspected first

- `package.json`, scripts: `test` and `test:node` invoke Vitest with `vitest.node.config.ts`.
- `vitest.node.config.ts:3–17`: Node environment, `src/**/*.test.ts`, verbose reporter, setup file `src/test/vitest-setup.ts`.
- `src/test/vitest-setup.ts:1–4`: installs an isolated state home.
- Observed Node **v24.14.1**, Vitest **v4.1.6**.
- Both executions used verification label **`estacoda-tests`**, scope **`.`**.

### Required focused suite

Exact command:

```sh
node --version; node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/benchmark/completion-recovery.test.ts src/runtime/provider-tool-narrowing.test.ts src/skills/skill-lifecycle.test.ts src/tasks/supervisor-task-background-host.test.ts src/tools/capability-tools.test.ts
```

**Result:** 5 files passed, **105 tests passed**, no failures, duration **2.10s**, **exit status 0**.

Execution receipt: `proc_fvi5lwo3`; exit confirmed through `process.logs`.

### Additional control, recovery, and delivery suite

Exact command:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts src/tasks/task-completion-delivery.test.ts src/tasks/foreground-task-handoff.acceptance.test.ts src/memory/memory-curation-service.test.ts src/providers/provider-executor-route.test.ts src/providers/provider-spend-enforcement.test.ts src/runtime/execution-approvals.test.ts; result=$?; printf '\nESTACODA_TEST_EXIT_STATUS=%s\n' "$result"; exit "$result"
```

**Result:** 7 files passed, **151 tests passed**, no failures, duration **8.43s**, **exit status 0**. Explicit output: `ESTACODA_TEST_EXIT_STATUS=0`.

Execution receipt: `proc_uy6jaqcm`; exit confirmed through `process.logs`.

**Combined:** **12 test files, 256 tests passed, 0 failed**. This is a selected deterministic suite, not the whole repository suite, live transport testing, a model-quality score, or a comparison against another implementation’s test totals.

## Source-backed capability findings

### 1. Actual agent loop and evidence-based completion

The implementation is more than a prompt wrapper:

- `src/runtime/agent-loop.ts:272`, `AgentLoop`; `:384`, `handle`: foreground orchestration entry.
- `src/runtime/provider-turn-loop.ts:294`, `ProviderTurnLoop.run`: provider/tool iteration, with per-turn budget reset at `:350`, execution through `ToolPlanRunner` at `:788`, capability-recovery application at `:935–984`, and completion validation/repair at `:1187–1218`.
- `src/runtime/agent-loop.ts:1320–1347` derives final outcome using request requirements, tool executions, execution receipts, termination cause, and completion floor. A remaining completion-validation failure explicitly downgrades an otherwise completed outcome at `:1335–1337`. Workspace finalization happens before canonical completion publication at `:1339–1341`.

**Executed evidence:** `src/benchmark/completion-recovery.test.ts:13–74` registers a scripted offline provider but calls the production `benchCommand` path, writes actual temporary workspace files, executes actual commands, and inspects emitted events. Six cases cover topic-input handling, excluded output files, renamed validation, a crashed check, a denied check, and unrepaired validation.

**What this proves:** deterministic enforcement and recovery through production runtime wiring.

**What it does not prove:** semantic quality of a generated document or real-model repair ability. For example, the fixture writes `"ready\n"` and uses scripted provider responses; the test is about runtime completion rules, not whether documentation actually explains every schema key (`src/benchmark/completion-recovery.test.ts:20–45`, `:54–56`).

### 2. Tool exposure is distinct from execution authority

- `src/runtime/provider-tool-narrowing.ts:1–21` combines tool-schema budgeting, request requirements, and selection policies.
- `src/tools/capability-tools.ts:16–19` sets bounded recovery limits: eight results, eight additions, two rounds.
- `src/tools/capability-tools.ts:169–189` validates requests and returns `applies: "next_iteration", grantsAuthority: false`; only successful, allowed execution receipts are eligible for subsequent application.
- `src/runtime/provider-turn-loop.ts:935–984` applies recovery requests to the next active tool exposure; skill instructions must still be read and this does not automatically activate a playbook/toolset.
- `src/runtime/tool-plan-runner.ts:355–375` forwards execution to `ToolExecutor` with workspace trust, session identity, approval handlers, delegate-call budget, and runtime admission guard.
- `src/tools/tool-executor.ts:640` checks that tool arguments have not changed after authorization.

**Executed evidence:** provider narrowing and capability tests passed, including:
- inability to reintroduce tools excluded from the resolved catalog;
- separate availability/eligibility/budget/selection diagnostics;
- forged, stale, denied, or copied receipt rejection;
- tool-count and serialized-schema token ceilings;
- confirmation requirements without premature exposure;
- changed skill definitions and incomplete instruction-read rejection.

Relevant test cases: `src/tools/capability-tools.test.ts:32–144`, `:180–230`; `src/runtime/provider-tool-narrowing.test.ts`, `narrowProviderToolsForTurn` and bounded diagnostics.

**Qualification:** discoverability is not readiness, readiness is not authorization, and authorization is not observed success.

### 3. Durable delegation, task graphs, concurrency, and budget controls

- `src/tools/delegation-tools.ts:56–60` describes inherited eligible parent-visible tools and explicitly retains workspace trust, runtime approval, and Task authority.
- `src/tools/delegation-tools.ts:176` requires a stable provider tool-call ID for idempotent creation.
- `src/tools/delegation-tools.ts:315–324` supports auto/background execution preference and rejects caller-supplied `spendingLimit`; operator-configured limits apply.
- `src/tasks/task-schema.ts:758–786` contains immutable child-budget reservation enforcement and a trigger requiring matching reservation data for a child Task.
- `src/tasks/task-scheduler.ts:263–325` reconciles owned work, checks dispatch grants, dependency-ready steps, available executors, retry delay, capacity, and execution-limit reasons before claiming and starting an Attempt.
- `src/tasks/task-scheduler.ts:2070–2097` checks task/step wall-clock, provider-call and token usage; `:2107–2138` accounts for active capacity and enforces profile, Task, root-task tree, executor, and provider concurrency.

**Executed evidence:** scheduler and spending tests passed for:
- durable concurrency across different scheduler owners;
- independent executor/provider limits;
- cancellation racing launch;
- durable dispatch before completion;
- dependencies and durable result acceptance;
- parallel spend reservations preventing session oversubscription;
- pre-dispatch spend denial and reservation settlement;
- zero-call limits and exact spending-denial preservation;
- token/call exhaustion preserving diagnostic output without accepting missing coverage.

This supports durable orchestration and admission controls, **not unlimited parallelism or a demonstrated throughput advantage**.

### 4. Foreground/background handoff and recovery

- `src/tasks/supervisor-task-background-host.ts:43`, `SupervisorTaskBackgroundHost`: separate background ownership manager.
- `:205–217`: workspace-runtime admission is bounded by scheduler capacity.
- `:265–270`: bounded, rotating dispatch grants.
- `:299`, `:363–382`: expiring host leases and renewal.
- `:325–345`: ownership release and trusted-workspace validation.
- `src/tasks/agent-step-executor.ts:414–434` distinguishes tool/evidence failures and preserves diagnostic output rather than accepting a false result.
- `:554–559` explicitly treats a prior draft as **not accepted evidence**, asks for relevant source re-verification, and includes unresolved feedback.

**Executed evidence:** background-host tests passed for active foreground lease exclusion, isolated lazy workspace executors, capacity admission, trust revocation during lazy creation, fencing, expired foreground host takeover, and retryable disposal failures.

Foreground acceptance tests passed for three-worker dispatch without a gateway, session switching, single synthesis, safe cross-workspace recovery, crash fencing, and unresolved approval handoff.

**Operational limitation:** persistence does not make every interrupted action safely retryable. Scheduler tests explicitly pause started unknown/non-idempotent work for operator review; late or expired results are fenced out. This is a safety boundary, but it limits unattended recovery.

### 5. Completion delivery is durable but not exactly-once across ambiguous external crashes

- `src/tasks/task-completion-delivery.ts:95–108` permits explicit retry of confirmed failed deliveries while protecting authorization.
- `:111–147` documents and implements interrupted external deliveries as `delivery-outcome-unknown`, failed, and **not automatically retried**.
- `:150–240` claims pending delivery records, renders completion from durable Task data, invokes a delivery router, and settles observed outcomes. CLI destinations are excluded from this external sending path.

**Executed evidence:** delivery tests passed for answer-first formatting, synthesis as the primary result, pending workspace-file messaging, deterministic no-answer receipts, qualified partial/failed/cancelled work, and bounded preview plus full report.

**Real limitation:** the source does **not** promise exactly-once external delivery across the send/ack crash window. A message may have been sent before the process crashed; automatic retry is deliberately withheld. No Telegram/Discord/email/WhatsApp network delivery was exercised.

### 6. Memory lifecycle and approval

- `src/memory/memory-curation-service.ts:187–208` reviews new session messages, builds candidates, and applies eligible automatic candidates.
- `:208`, `:294–318` separates pending-review candidates from auto-apply mutations.
- `src/memory/memory-reviewer.ts:91–130` routes explicit policy conflicts, insufficient explicitness, sensitivity, low confidence, missing source spans, excessive risk, scanner rejection, review-required categories, and budget overflow away from automatic acceptance.
- `src/memory/memory-reviewer.ts:151` handles secret/sensitive facts.
- `src/memory/memory-mutation-service.ts:15`, `:45` centralizes mutation sources/service.

**Executed evidence:** curation tests passed for immutable finalization cutoffs, missing-cutoff failure closure, retryable failed mutations without cursor advancement, and disposal-audit throttling.

**Qualification:** not every memory write requires a fresh human approval. Source supports policy-gated auto-application and pending review. The executed tests establish selected governance and persistence behavior, not extraction accuracy on unrestricted real conversations.

### 7. Skill learning, promotion, approval, and rollback

- `src/skills/skill-learning.ts:32` defines `none`, `suggest`, `proactive`, and `autonomous`.
- `:475–480` gates proposal creation on evolution policy and a bounded daily proposal budget.
- `:526–548` drafts evidence-linked patches and optionally invokes promotion if policy and eligibility permit.
- `src/skills/skill-proposal-service.ts:249–286` serializes promotion under a profile write lock, verifies trust/current contents/task-evaluation requirements, and restricts automatic changes.
- Specifically, `:273–276` requires automatic-promotion policy, no enabled skill-write approval, runtime-internal trust, low risk, base-content hash, and a text patch.
- `:345–351` revalidates authority and cancellation around mutation.
- `:404`, `rollbackProposal`; `:1397` states automatic learning never changes frontmatter, resources, routing, or declared authority.

**Executed evidence:** lifecycle tests passed for stale/authority-expanding patch rejection even with approval; rejection of tied/regressing/unsafe/mismatched paired evaluations; failure to accept unexecuted end-state assertions; automatic local correction and undo; pinned/revoked/cancelled/stale/approval-enabled blocking; foreground cancellation of background model review; shared-profile serialization; and learning from settled delegated outcomes after restart, not dispatch.

**Qualification:** “self-improving” here means governed local artifact evolution with evidence and policy limits—not autonomous permission expansion or demonstrated generalized model improvement.

### 8. Provider architecture and integrations

- `src/config/runtime-config.ts:2565–2648`, `buildProviderRegistry`:
  - registers executable OpenAI Responses adapters at `:2587–2604`;
  - otherwise registers OpenAI-compatible adapters at `:2608–2624`;
  - network execution depends on configured headers and `enableNetwork`, default false (`:2602`, `:2622`);
  - skips custom executable providers lacking a base URL (`:2581–2584`);
  - separately registers catalog-only providers (`:2628–2644`).
- `src/config/provider-diagnostics.ts:55–58` explicitly warns when no adapter exists or a provider is discovery-only/non-executable.
- `src/providers/provider-registry.ts:3–40` separates registered adapters, model discovery, and provider health.
- Observed channel implementation modules include Telegram, Discord, email, and WhatsApp under `src/channels/`; this establishes source adapters only, not configured live availability. MCP provenance participates in narrowing (`src/runtime/provider-tool-narrowing.ts:7`).

**Executed evidence:** provider route and spending suites passed. No live provider inference, OAuth login, integration setup, or live channel traffic was tested.

**Real limitation:** a provider/model catalog listing is not evidence of executable protocol support, configured credentials, region/service availability, or present-day model availability.

## Shortcomings and evidence boundaries for synthesis

1. **No comparative live-model coding benchmark:** these 256 checks establish selected runtime mechanics, not task-solving superiority.
2. **Scripted completion fixture:** production wiring and real processes, but deterministic model responses and deliberately simple output content.
3. **Bounded recovery:** two completion-repair attempts (`src/runtime/provider-turn-loop.ts:1194–1202`) and two capability-recovery rounds (`src/tools/capability-tools.ts:19`); unresolved work can remain blocked/partial.
4. **External send ambiguity:** no automatic retry after an unknown external delivery outcome; manual resolution can be required (`src/tasks/task-completion-delivery.ts:95–147`).
5. **Unsafe crash recovery requires operators:** unknown or non-idempotent started work is not freely replayed.
6. **Provider catalog ≠ execution support:** separate source paths and explicit diagnostics confirm this.
7. **Manifest inconsistency:** listed `src/runtime/recoverable-draft.ts` was absent; full hash audit remains unperformed.
8. **No live deployment claims:** no deployed runtime inspection, live transports, credentials, network, full-suite execution, end-to-end real-model learning evaluation, or scale/load testing.

No selected tests failed. Two exploratory reads targeted a nonexistent `src/tools/tool-plan-runner.ts`; the correct inspected module is `src/runtime/tool-plan-runner.ts`. These were path lookup errors, not test failures.

## Outstanding parent obligation

This worker intentionally did **not** write `reports/superagent-vs-estacoda.md`. The parent must combine independent scopes, save the complete accepted synthesis, and verify the saved file by readback. This Step’s result supplies EstaCoda source evidence and executed test receipts only.
