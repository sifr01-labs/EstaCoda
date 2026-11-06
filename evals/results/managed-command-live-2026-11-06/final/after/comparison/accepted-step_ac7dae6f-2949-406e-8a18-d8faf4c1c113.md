EstaCoda shows durable, policy-gated orchestration and broader agent infrastructure; 172 targeted tests passed. GitHub autonomy and live coding quality remain unverified.

## Scope and provenance

- Investigated **EstaCoda root `src`**, not either upstream checkout.
- Observed `MANIFEST.json:2` records subject revision **`62246ec5afb60cde7d1a9cb4d57b0bcfb421f1b2`**.
- Workspace fixture HEAD **`78541dcbb8ea725e4664aa3a45d0ebc3cda21fc7`** was supplied by the assignment; I did **not** independently verify HEAD with Git.
- No network, installation, deployment, or intentional source edits were performed. Tests created isolated temporary state; no post-test Git status/source-integrity check was performed.
- This is worker evidence for the final synthesis, **not** the saved report. Writing and reading back `reports/superagent-vs-estacoda.md` remains the parent/synthesis step’s obligation.

## Findings and implications

### 1. Delegation is durable task admission, not merely parallel prompts

**Implementation observed**

`DurableDelegationService` explicitly converts requests into durable task graphs and does not itself execute or wait for workers (`src/delegation/durable-delegation-service.ts:155–156`).

Important admission and lifecycle behavior:

- `inspectAccess` previews authority without creating a task (`:211–218`).
- `createAndActivate` persists through `create` first; activation failure returns a durable handle marked `post-commit-activation-failed`, rather than losing the task (`:220–233`).
- `create` rejects untrusted workspaces and invalid batch sizes (`:236–240`).
- A report/research contract cannot have its required synthesis disabled by a model flag (`:242–247`).
- Admission validates worker count, delivered skill instructions, distinct research-worker contracts, freshness capability requirements, and synthesis requirements (`:249–260`).
- Children cannot redefine the root monetary scope (`:270–272`, approximately; the observed excerpt ends immediately after this check).
- The handle distinguishes foreground/background/waiting execution and explicitly allows background-continuation status to be `available`, `unavailable`, or `unknown` (`:78–103`).

**Executed evidence**

The durable delegation suite passed cases covering:

- Immutable fan-out graph plus terminal synthesis.
- Worker-before-synthesis ordering and preservation of graph/primary result across restart.
- Partial synthesis when another worker fails.
- No synthesis when no worker has accepted evidence.
- Cancellation of workers and synthesis together.
- Rejection of changed immutable definitions on replay.
- Rejection of stale, expired, or cancelled parent leases.
- Narrowed child authority and budgets.
- Reservation rollback and competing reservations.
- Descendant usage/deadline/concurrency enforcement.
- Durable-handle preservation after post-commit activation failure.
- Fail-closed admission when requested/effective child tool access is unavailable.

Source test file: `src/delegation/durable-delegation-service.test.ts`; exact test names were observed in execution output, but their individual source line numbers were not collected.

**Comparison implication**

This provides a substantive general-purpose orchestration foundation for a repo agent: durable ownership, results, synthesis and constrained descendants. It is not evidence that a complete GitHub issue-to-PR workflow is wired to that foundation.

### 2. Recovery deliberately distinguishes safe retry from uncertain side effects

The executed `TaskScheduler` suite provides unusually discriminating recovery coverage:

| Behavior established by passing test | Source reference |
|---|---|
| Dependencies settle only after durable result acceptance | `src/tasks/task-scheduler.test.ts:117` |
| Expired/superseded host grants denied without attempts | `:243` |
| Revalidate fencing after ownership race | `:266` |
| Only one competing scheduler dispatches under the same grant | `:305` |
| Fence and requeue unfinished attempt for host handoff | `:374` |
| Deterministic retry backoff, no reused logical dispatch | `:569` |
| Pause uncertain non-idempotent work for operator review | `:599` |
| Bound automatic accounting recovery to one safe retry | `:631` |
| Missing/empty required durable results fail acceptance | `:647`, `:660` |
| Atomic-publication retry avoids stale/duplicate results | `:734` |
| Roll prepared results back after invalid later settlement | `:797` |
| Cancellation aborts local execution and rejects late success | `:858` |
| Lease-expiry reconciliation after restart obeys retry policy | `:1243` |
| Reuse queued crash-boundary attempt, not duplicate dispatch | `:1405` |
| Reject settlement after lease expiry | `:1423` |
| Durable approval pause resumes same attempt with higher fence and preserved usage | `:1509` |
| Wait for all parallel approvals; denial leaves no live sibling execution state | `:1589`, `:1664` |
| Spending denial preserves completed results | `:1720` |

**Tradeoff/gap**

The safety design intentionally stops for operator intervention when effects are uncertain. That is a strength against duplicate mutations, but it limits unconditional unattended completion. These are deterministic scheduler/store/executor tests, not a demonstrated restart of a deployed GitHub service under production load.

### 3. Approval is exact-action policy enforcement, not a Boolean permission prompt

In `ToolExecutor.executeTool`, the security request incorporates tool name, risk class, target summary, environment, trusted-workspace context, and optional data-egress information. The executor assesses policy and records the assessment (`src/tools/tool-executor.ts:390–412`).

When policy asks:

1. It requests approval with the pending approval and cloned tool input.
2. Callback exceptions default to denial.
3. An “approved” callback triggers **policy reassessment**.
4. If policy still asks, execution is denied because approval did not authorize the exact call.
5. Cancellation or operator denial yields explicit denial.

References: `src/tools/tool-executor.ts:414–455`.

The selected dispatch authorization tests both passed:

- An assessed grant is fenced after revoke-and-identical-regrant; fresh work can proceed.
- Unrelated changes preserve covered/pending grants, while relevant revocation fences them.

Source: `src/security/dispatch-authorization.test.ts` (individual source line references not collected).

**Implication and limit**

This is stronger evidence than merely finding approval-related files: exact-call reassessment and revocation races were exercised. It does not establish that every tool’s target canonicalization, sandbox boundary, or external integration is secure. Those broader surfaces were not audited.

### 4. Learning is inspectable and gated; not autonomous self-improvement proven by outcome

`SkillLearningManager` records workflow observations, candidates, provenance, draft state and review jobs (`src/skills/skill-learning.ts:32–109`).

Observed control points:

- Autonomy modes: `none`, `suggest`, `proactive`, `autonomous` (`:32`).
- Observation exits unless autonomy/policy/evidence-store prerequisites allow it (`:180–188`, within the observed `observeTurn` excerpt).
- Delegated turns are deferred with task IDs so learning can wait for settlement evidence (`:190–199`).
- Selected-skill observations require their own policy permission (`:201–212`).
- Workflow observations carry session/tool/outcome information.
- The observed new-workflow evidence explicitly sets `sourceTrust: "runtime_internal"`, `mayPromoteAutomatically: false`, and `requiresHumanApproval: true` (near the end of the observed `:215–230` excerpt).

The scheduler test at `src/tasks/task-scheduler.test.ts:100` passed: learning is notified only after settlement/result publication, and observer failure cannot reject delivery.

`src/skills/skill-learning.test.ts` was also included in the successful run. Individual skill-learning test output/counts were not retained in the final log excerpt, so I do not assert specific additional cases from that suite.

**Tradeoff/gap**

The implementation supports workflow learning with inspectable evidence and proposal machinery. It does not prove that generated skills are correct, useful, or improve coding success. The observed path is explicitly gated; it should not be summarized as unrestricted automatic skill promotion.

### 5. Memory has incremental, policy-controlled curation, but was not tested in this run

`MemoryCurationService`:

- Builds around `MemoryStore`, `MemoryCurationStore`, `MemoryMutationService` and optional index synchronization (`src/memory/memory-curation-service.ts:80–115`).
- Triggers after a configured completed-turn threshold (`:117–132`).
- Respects enabled triggers and manual mode (`:134–151`).
- Supports exclusive checkpoint coordination (`:153–158`).
- Bounds extraction by message cutoffs, previous source-message count, disposal interval, and minimum new-message thresholds (`:172–205`).
- Passes extraction output through `reviewMemoryFacts`; failed extraction supplies no facts (`:199–205`).
- Restricts the curatable operation type to `USER.md` and `MEMORY.md` (`:26`).

**Limit**

I inspected the beginning of this pipeline, not its complete mutation/approval/promotion path. No memory test suite was executed. Do not infer universal approval requirements, protection against all memory poisoning, or working external-memory setup from this inspection.

### 6. Breadth is architectural and configuration-dependent, not demonstrated availability

**Providers**

The provider contract includes OpenAI-compatible/local routes and named provider IDs for DeepSeek, Kimi, MiniMax, Google, Anthropic, OpenAI, OpenRouter, Nous and Z.ai, with extensible string IDs (`src/contracts/provider.ts:1–14`).

`ProviderRegistry` registers adapters, lists their models, and computes available providers by actually calling each adapter’s `health()` (`src/providers/provider-registry.ts:3–40`). Therefore the ID union or catalog alone is not proof of an available working provider.

The provider fallback suite passed tests for:

- Bounded transient retries and configured fallback.
- Deadline/cancellation handling.
- No promotion of partial text/tool fragments to successful output.
- No arbitrary registered-model fallback.
- Explicit credential-boundary handling for authentication fallback.
- Clear failure when all configured routes fail.

Source: `src/providers/provider-executor-fallback.test.ts`; exact named cases were observed in the successful execution log, but line references were not collected.

**Channels**

`AdapterRegistry` builds capabilities for Telegram, Discord, email and WhatsApp (`src/channels/adapter-registry.ts:13–19`). It explicitly says it neither instantiates adapters nor tracks runtime state (`:5–8`) and distinguishes enabled/configured/misconfigured states (`:23–46`).

**Implication**

EstaCoda has broader general-agent integration surfaces than a narrowly repo-centric application. These findings establish contracts/registry logic and mocked fallback behavior—not authenticated live services, current model availability, or deployed channel readiness.

## Repo-centric autonomy: what is and is not established

**Supported strengths relevant to an autonomous GitHub agent**

- Durable fan-out/synthesis and replay-safe admission.
- Fenced ownership, retries, cancellation and operator recovery.
- Exact-call approvals and revocation handling.
- Descendant authority, spending, concurrency and deadline limits.
- Learning evidence separated from unsettled output.
- Provider/channel abstraction breadth.

**Unverified comparative gaps**

This bounded root inspection did **not** trace an end-to-end GitHub pipeline for webhook intake → issue selection → isolated coding workspace → tests → branch/commit → PR → review-response loop. Accordingly:

- Do not claim EstaCoda lacks those capabilities.
- Do not credit it with a demonstrated GitHub-native autonomous workflow.
- Do not claim general task durability automatically guarantees safe retry of GitHub mutations.
- Do not rank its coding performance against Superagent from these tests.

A broad source search returned managed-worktree/identity-related paths, but those files were not read in this investigation. I therefore make no substantive worktree-isolation claim.

## Exact executed check

Configuration reviewed **before execution**:

- `package.json`: Node requirement, scripts and dependency declarations.
- `vitest.node.config.ts:1–20`: Node environment, `src/**/*.test.ts`, verbose reporter, setup file.
- `src/test/vitest-setup.ts:1–4` and `src/test/state-home.ts:1–10`: each test process installs a temporary isolated HOME.

Command:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts src/delegation/durable-delegation-service.test.ts src/security/dispatch-authorization.test.ts src/skills/skill-learning.test.ts src/providers/provider-executor-fallback.test.ts --maxWorkers=1
```

Declared verification inputs:

```text
src
vitest.node.config.ts
package.json
node_modules
tsconfig.json
```

Observed result:

```text
Vitest v4.1.6
Test Files  5 passed (5)
Tests       172 passed (172)
Duration    11.25s
Exit code   0
```

- **Failed tests:** none in the executed selection.
- **Blocked selected suites/native dependency errors:** none observed.
- Manifest declares `vitest: ^4.1.5`; the prepared installed runner reported `4.1.6`.
- One test command was executed; no install, lifecycle script, live-model request, deployment or network experiment was run.
- Some verbose intermediate output was truncated, but the retained final process receipt explicitly established completion, totals and exit code.

## Outstanding obligations and limits

1. Parent must combine this evidence with separately inspected Superagent/Harness findings; no upstream source was inspected by this worker.
2. Parent must save and read back the accepted final report at `reports/superagent-vs-estacoda.md`.
3. Independent fixture HEAD verification remains outstanding.
4. Memory end-to-end behavior, actual channel/provider readiness, GitHub-native automation and worktree implementation remain unverified here.
5. No live-source freshness/launch verification was performed or claimed.
6. Passing deterministic tests demonstrates selected implementation behavior, **not comparative live-model coding success, speed, cost, or production readiness**.
