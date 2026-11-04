dsh-superagent is a research-prototype Harness bundle, not an official DeepSeek product. Its inspected application tests passed; live launch, coding performance and deployment remain unverified.

## Scope and provenance

- **Assigned scope:** `superagent-application`, not the final comparative synthesis.
- **Benchmark date:** 2026-11-04 UTC (provided benchmark context).
- **Pinned revision:** `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`, recorded in `UPSTREAM.json`.
- `AGENTS.md` explicitly says these are **source research fixtures, not deployed services**, and prohibits interpreting native test counts as comparative live-model coding performance.
- **Identity correction:** `upstream/superagent/README.md:3–5` calls this a “Research prototype for reference only, not an official DeepSeek product,” warns it is not production-ready, and says the published code differs from both the internal implementation and article. Some article designs are unimplemented future directions.
- **Application, not standalone runtime:** `upstream/superagent/package.json` (`description`, `dsh.bundle`, `peerDependencies`) describes a one-repository proactive application packaged for DeepSeek Harness. Its session, agent, subprocess, permission, workspace, persistence, tools and provider functionality depends on Harness packages. Evaluate **Superagent + Harness**, not the bundle alone.

### Public links and freshness

The inspected README contains the source-backed Harness landing URL:

- `https://www.deepseek.com/en/harness/` — `upstream/superagent/README.md:7`.

The inspected source names the article **Exploring Super-agent Design: Towards a More Autonomous Agent System**, but does **not** provide its HTTP(S) URL (`README.md:5`). Targeted local searches did not establish a canonical Superagent repository URL or article URL. **Do not fabricate either from naming conventions.** No web-search source was obtained; the URL above is a locally observed link, not a live-verified citation. Launch date, latest release and current public availability remain unverified because network fetching/search was unavailable.

## Implementation evidence: event to result

| Stage | Observed implementation and implications |
|---|---|
| **Intake and deduplication** | `upstream/superagent/src/core/intake.ts`, `Intake.receive`: normalizes timestamps, rejects triggers without threads, returns `duplicate` for stored trigger IDs, records filtered triggers/dispositions, correlates threads and fans inputs into subscribed tickets. Filtered events are auditable rather than silently forgotten. |
| **Follow-up boundaries** | Same symbol: only human messages on non-context threads can resume ended tickets; bots/CI do not do so. Human-stopped tickets receive no inputs because their mandate was withdrawn. Context-only subscriptions do not establish decision ownership. Unowned triggers go to evaluation. |
| **Identity and admission** | `upstream/superagent/src/policy.ts:190–212`, `settingsPolicy().gate`: uses source-native actor identity, configured sender lists, addressed/direct status, source observation scope, admission-table cells and existing ticket participation. An allowed addressed human is explicit; unlisted follow-ups may be inferred according to mode. Nonhuman actors go through a separate machine gate. This is not simply “any mention launches work.” |
| **Inferred autonomy** | `policy.ts:212`: inferred work requires `mode === 'auto'`, a nonempty matched-rule list and every matched rule still enabled. `policy.ts`, `directionAllowed`: implementation intent, established target and absence of open design decisions are explicit checks. The application bounds proactive action through policy rather than granting unlimited self-directed work. |
| **Authorization revalidation** | `policy.ts:213–242`, `revalidate`: checks currently listened scope, sender/admission strength, listed bot status, observation mode and enabled rules. Nuance: **explicit follow-up mandates remain valid** under this branch; do not describe revalidation as unconditional sender-list revocation for every mandate. |
| **Routing into tickets** | `upstream/superagent/src/app/tools/main.ts`, `route`, `routeTool`: accepts explicit requests, attaches related messages, ignores candidates or stops a ticket. Each batch item runs independently and returns its own refusal; one failure does not discard other items. Accept retries retain the existing ticket/title/acknowledgement. Inferred acceptance is routed to a separate assessment tool, not accepted by the explicit routing path. |
| **Durable state** | `upstream/superagent/src/app/store.ts:2,52,60` uses Node `DatabaseSync`; ticket/trigger mutations use transaction helpers. `src/core/engine.ts`, `Engine` wraps state transitions in `repo.atomic`. `src/executor/dsh.ts`, `DshExecutor` queues launch and delivery work through durable `Effects`. |
| **Session/workspace separation** | `upstream/superagent/src/executor/dsh.ts`, `workerSessionId`, `ticketWorktreeName`, `DshExecutor.prepare`: deterministic `worker-<ticketId>` session IDs and validated worktree names with ticket suffixes; per-ticket persistent sessions and workspace directories. **Directory/session separation is not evidence of a security sandbox.** |
| **Execution permissions** | `upstream/superagent/src/app/sessions.ts`, `Sessions.ensure`: explicitly sets `ctx.permissionPresets.set(..., 'danger-full-access')`. Application admission is therefore an important gate; do not imply every subsequent shell/file action receives human approval. |
| **Tool restrictions** | `sessions.ts`, `WORK_TOOLS`: workers get files, shell/jobs, web, skills, todo and subagents, but not tools for asking/showing a person something, changing profile, scheduling goals, arbitrary session management or document editing. These are useful API-level restrictions, **not proof that arbitrary shell commands cannot achieve equivalent effects**. |
| **Concurrency and human attention** | `src/executor/dsh.ts`, `WorkerSlots`: synchronously reserves startup slots, includes running background jobs/subagents in slot accounting, and permits **one extra slot for a human follow-up**. Paused processing holds launch/delivery handlers. Main-session `noWait` guards discourage long blocking waits so routing remains responsive. |
| **Recovery** | `src/core/engine.ts`, `assignmentInterrupted`: restarts interrupted work with a recovery note, except qualifying waiting/ready/blocked/failed states with no subsequent worker input, where session/state is retained. `src/executor/dsh.ts`: transient network/provider failures have three attempts and 15-second initial backoff; workspace prepare failure deliberately fails immediately because a dirty partial directory must not be mistaken for a prepared workspace. Background continuation is bounded to 30 minutes; shutdown waiting is bounded to 10 seconds. |
| **Output and PR linkage** | `src/app/tools/main.ts`, accept routing requires an acknowledgement intended for the original source. `src/app/store.ts:263–287` implements pending/sent/dropped outbox receipts and withdrawal. `src/app/sessions.ts`, `relay`/`notify` and `AgentDelivery` provide durable, request-ID-deduplicated session delivery. `src/core/engine.ts`, `report` tracks attention and completion, including completion dependent on followed threads. **I did not finish inspecting the actual PR-creation path, so cannot certify its authorization or branch safety end to end.** |

## Approvals, memory, evolution and costs

### Approval distinction

There are at least three distinct concepts; avoid collapsing them:

1. **Admission/authorization of work:** implemented policy checks above.
2. **Human attention/hold and stop/resume:** engine reports, attention state, pause and ticket lifecycle.
3. **Per-tool execution approval:** the inspected managed-session path instead selects **`danger-full-access`**.

`src/core/engine.ts`, `report` documents that blocked/failed reports hold automated inputs until a human message arrives; completed/ready reporting clears attention. That is a recovery/attention workflow, not evidence of a universal approval gate around side effects.

### Skills and evolution

- `upstream/superagent/src/app/skill-files.ts`, `bundledSkills`: packaged GitHub and Feishu skills.
- `src/app/prompts.ts`, `Prompts.skills`, `composeSkill`: built-in skills plus custom team skills registered into sessions.
- `Prompts` stores numbered prompt configurations via `Versions`, supports previews/validation and optimistic concurrency conflict (`PromptConflict`).
- Validation preserves template placeholders and enforces size limits; source comments describe HTTP 409 on stale revisions.
- `src/app/sessions.ts`, `promptVersion` and `mayRead`: tracks session prompt revisions and authorizes reads of active/previously used revisions.

**Finding:** genuine inspectable, versioned prompt/skill customization—not merely a README claim. **Not established:** automatic cross-task memory curation, workflow-learning promotion, self-evolving skill quality evaluation or autonomous code self-improvement. `src/core/memory.ts`/`MemoryRepositories` should not be presented as semantic lifelong memory merely because of its name.

### Provider budgets and costs

- `src/app/sessions.ts`, `initializeRoleModel`: separate orchestrator and worker model selection.
- `src/app/retry-health.ts`, `RetryHealth`/`budgetFailure`: projects provider budget-exhaustion state from structured failures and retry/session events.
- That implementation is **observability of budget waits**, not independent application-level cost enforcement.
- No measured dollar cost, tokens per completed task or comparative efficiency was obtained. Harness-level provider budgeting is outside this worker’s verified scope.

## Executed checks

Inspected `package.json` scripts (`test: vitest run`, `check` additionally typechecks/builds) and `vitest.config.ts` before execution. Invoked Vitest directly: **no install, package lifecycle scripts, external service calls or source modifications**.

Both `terminal.run` calls used the requested verification label and `verificationInputs: ["."]`.

| Verification label | Actual command | Receipt |
|---|---|---|
| `superagent-core-policy-store` | `cd upstream/superagent && node node_modules/vitest/vitest.mjs run tests/core-engine.spec.ts tests/policy.spec.ts tests/store.spec.ts` | Successful tool receipt; Vitest: **3 files passed, 458 tests passed, 0 failed**, duration **373 ms**. Individual counts: engine 113, policy 328, store 17. |
| `superagent-runtime-recovery` | `cd upstream/superagent && node node_modules/vitest/vitest.mjs run tests/runtime.spec.ts tests/runtime-concurrency.spec.ts tests/effects.spec.ts tests/outbox.spec.ts tests/delivery.spec.ts` | Successful tool receipt; Vitest: **5 files passed, 177 tests passed, 0 failed**, duration **7.53 s**. Counts: runtime 91, concurrency 56, effects 13, outbox 2, delivery 15. |

**Total observed:** 8 passing files, **635 passing tests**, no reported failures or skips.

**Exit-status precision:** tool responses reported successful execution (`ok=true`) and complete passing Vitest output, but did **not display a numeric process exit-status field**. A literal independently captured `exit 0` receipt is therefore missing; do not manufacture one.

**Warnings/prerequisites:**

- Node emitted the SQLite experimental-feature warning during both runs.
- No unavailable prerequisite blocked these selected suites.
- A separate `terminal.inspect` attempt to list `upstream/superagent/node_modules/.bin` was denied as “path is outside the trusted workspace.” This is an inspection failure, **not a failed test or proof dependencies were absent**.
- No full-suite run, typecheck or build was performed.

### What these tests establish

The core harness uses `MemoryRepositories`, mocked assessors/executors and deterministic clocks (`tests/core-engine.spec.ts:1–75`). Its intake test explicitly checks stored/duplicate/filtered outcomes (`:77–85`).

Runtime tests exercise real application/SQLite state while substituting host services: `tests/runtime.spec.ts:90–168` stubs subprocess answers, GitHub/Feishu commands, agent/session controllers and message delivery. These are meaningful deterministic application integration tests, **not actual GitHub operations, real Harness/model sessions or real model-coded PRs**. The concurrency receipt includes a passing test holding delivery until hand-off subagents finish stopping.

## Fair benchmark implications for synthesis

**Strongest supported application strengths**

1. A concrete team-oriented repository workflow: source-native intake → explicit/inferred mandate → ticket → persistent worker → durable delivery/attention.
2. Detailed negative-path engineering: duplicate intake, filtered-event records, batch-item refusals, revalidation, human-stop semantics, dirty-prepare failure handling and interruption recovery.
3. Human-priority concurrency and versioned operational prompts/skills.

**Material caveats**

1. High-trust execution: managed sessions select `danger-full-access`; per-ticket directories are not a demonstrated sandbox.
2. “Proactive” is constrained, rule-backed observation and follow-up—not evidence that every article vision is implemented.
3. Strong mock-backed regression results do not establish production reliability, provider economics or coding intelligence.
4. This application scope does not independently verify the underlying Harness implementation or EstaCoda capabilities; those must come from the other comparison scopes.

**Useful comparison axes:** compare EstaCoda’s demonstrated approval, durable execution, workspace isolation and learned-skill mechanisms against these specific implemented mechanisms—not against a generic “Superagent” name or its article aspirations.

## Outstanding obligations and limits

- Canonical Superagent repository URL and article URL: **not established in this scope**.
- Live launch/latest status: **unverified**.
- Actual PR-creation/branch-authorization path: **inspection incomplete**.
- Numeric process exit receipts: **not exposed in returned output**.
- Real external-service, deployed-runtime or live-model benchmark: **not performed**.
- No claim of comparative coding intelligence is supported by these counts.
- No report file was written: this worker was instructed to return evidence only. Saving and reading back `reports/superagent-vs-estacoda.md` remains the synthesizer’s obligation.

Exploration limitations: 1 settled exploratory attempt(s) failed (terminal.inspect). These attempts are not evidence and remain recorded in the worker history. Acceptance of this report does not establish that every requested source was inspected. Use only successful observations and preserve any unresolved coverage gaps in synthesis.
