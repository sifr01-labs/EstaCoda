Harness supplies the model/tool loop, recovery, approvals and delegation; Superagent configures these for repository work. Tests ran, but final totals and exit status were not captured.

## Scope and provenance

Audited the prepared source fixture, not deployed services:

- Harness pin: `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`.
- Superagent pin: `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`.
- Evidence: `UPSTREAM.json:2–3`.
- Root research constraints: `AGENTS.md:2`.

No sources were edited, dependencies installed, lifecycle setup executed, or network restrictions bypassed. This investigation provides source-level architectural evidence and partial deterministic-test evidence—not a live-model performance benchmark or launch-date verification.

## Findings

### 1. The concrete model/tool loop belongs to Harness

The principal implementation is `Agent.step` in:

`upstream/harness/packages/core/agent-loop/src/agent.ts:435–605`.

Its concrete sequence is:

1. Render the assembled system prompt and refresh runtime context.
2. Append model-visible system/user context to the session.
3. Build the provider request.
4. Stream through a prepared provider call or `llm.stream`.
5. Record a successful assistant message, or durable interrupted/failed-attempt information.
6. Extract tool-call blocks.
7. Execute those calls through the Harness tool runtime.
8. Queue returned additional contexts for the next step.
9. Finish when there are no tool calls or execution explicitly concludes; otherwise continue.

Precise anchors:

- Request/context admission: `agent.ts:435–477`.
- Provider streaming: `agent.ts:479–500`.
- Interrupted attempt settlement: `agent.ts:501–540`.
- Request-error retry extension point: `agent.ts:544–567`, symbol/event `agent/request-error`.
- Assistant-message recording and tool execution: `agent.ts:570–603`.

**Attribution:** Superagent should not receive independent credit for implementing the fundamental provider/tool iteration mechanism. Its package declares Harness agent, LLM, tools, session, persistence, system-prompt and skill packages as peers: `upstream/superagent/package.json:62–85`.

### 2. Tool concurrency is implemented, bounded and ordered—not merely advertised

Harness’s native tool executor delegates to the common pipeline/batch scheduler:

- `upstream/harness/packages/core/tool-executor-native/src/index.ts:5–20`.
- `upstream/harness/packages/core/tools/src/batch.ts:40–95`, symbol `executeToolBatch`.

The batch scheduler validates an explicit concurrency limit, distinguishes parallel groups from exclusive calls, and drains started calls on abort. Results and additional contexts commit in model order. Exclusive reclassification acts as a barrier:

`upstream/harness/packages/core/tools/src/batch.ts:108–115`, symbol `runGroup`.

The agent passes its configured concurrency limit into execution:

`upstream/harness/packages/core/agent-loop/src/agent.ts:586–595`.

**Implication:** Distinguish parallel tool bodies from parallel agents and parallel repository tickets. Evidence for the first does not establish an unlimited or durable distributed scheduler.

### 3. Approval handling has explicit fail-closed cases

The pipeline’s approval adapter denies execution when approval support is absent or the call has no agent through which to route approval:

`upstream/harness/packages/core/tools/src/pipeline.ts:432–447`, symbol `serviceAsk`.

Only `allowed-once` becomes an allow decision; rejected, cancelled and unavailable outcomes become denials:

`pipeline.ts:449–471`.

The approval service declares durable per-session policy events:

`upstream/harness/packages/interaction/user-approval/src/index.ts:31–44`, event `approval/policy`.

Observed executed tests included negative cases for:

- No approval listener → unavailable.
- Throwing answerer → unavailable.
- Invalid answer vocabulary → unavailable.
- Cancellation and late answers/rejections.
- `never` policy remaining unbypassable by prepended answerers.
- Session overrides and policy changes.

Test source: `upstream/harness/packages/interaction/user-approval/tests/approval.spec.ts`, suites `ApprovalService.request` and `approval policy (the approval/policy fold)`.

**Boundary:** This is action-level tool approval machinery. It does not by itself establish that an external GitHub/Feishu request is authorized under Superagent’s application policy.

### 4. Sandbox policy and enforcement are separate capabilities

The inspected local sandbox provider selects platform-specific confinement runners and tracks enforcement quality:

`upstream/harness/packages/sandbox/sandbox-local/src/index.ts:513–552`, symbols `selectRunner`/`probeRunner`.

The source explicitly distinguishes:

- Bubblewrap and Seatbelt probes yielding full enforcement when usable.
- Landlock enforcement depending on the launcher’s probe result.
- Windows ACL enforcement reported as partial.

The partial Windows limitations are explicitly described around:

`upstream/harness/packages/sandbox/sandbox-local/src/index.ts:526–550`.

Policy tests inspect `read-only`, `workspace-write` and `danger-full-access`, including durable per-session switching:

`upstream/harness/packages/sandbox/sandbox-policy/tests/policy.spec.ts:18–22,45–172,248–288`.

**Important limitation:** No real OS confinement test was established as completed in this audit. Policy/source support must not be described as demonstrated kernel enforcement in this environment.

### 5. Recovery is real session-log repair, not proof of exactly-once external effects

Harness `resume` requires a persistence backend:

`upstream/harness/packages/core/agent-loop/src/index.ts:752–757`.

It acquires write ownership before reading and repairing the session, preventing concurrent writers from repairing the same live identity. It reads the physically valid log, generates interrupted-turn closers, appends them durably, then prepares the resumed session:

`index.ts:784–809`, symbols `resumeWith` and `interruptedTurnClosers`.

The repair closes missing tool results, steps and turns; it does **not** establish exactly-once replay of arbitrary external tool side effects.

Relevant inspected and visibly passing tests:

- Live-owner crash repair refused: `upstream/harness/packages/core/agent-loop/tests/resume.spec.ts:493`.
- Interrupted-turn durable closers: `resume.spec.ts:514`.
- Interrupted-tool repair: `resume.spec.ts:539`.
- Torn physical tail recovery: `resume.spec.ts:578`.
- Repair suffix persisted before publication: `resume.spec.ts:716`.
- History/numbering continuation: `resume.spec.ts:1119`.

These are meaningful recovery tests, not evidence of comparative coding quality.

### 6. Superagent is an application-specific preset/composition layer

The bundle explicitly composes Harness plugins:

`upstream/superagent/cordis.patch.yml:1–27`.

Its worker preset configures:

- Sandboxed shell tools with five-second foreground budgets: `cordis.patch.yml:38–62`.
- Filesystem/search tools: `:63–68`.
- Bounded job waits: `:69–74`.
- Filesystem skills and skill invocation: `:75–78`.
- Compaction/result pruning: `:79–95`.
- Spawned subagents using Harness’s `standard` preset: `:96–111`.
- Todo and search tools: `:112–120`.

The router preset separately excludes subagents and disables filesystem write/edit:

`cordis.patch.yml:121–132,163–176`.

**Attribution:** Shell execution, jobs, skills, compaction, subagent tools and tool scheduling here are inherited Harness capabilities configured by Superagent. Superagent’s application-level request intake, policy evaluation, tickets and repository orchestration require separate attribution from its application implementation; this worker did not complete that independent trace.

### 7. Skills, MCP and extensibility: supported, with narrower verification

**Skills:** Superagent explicitly loads Harness filesystem-skill discovery and skill tools in both worker and router presets. Harness’s parser validates YAML frontmatter, name and description:

`upstream/harness/packages/skill/skill-filesystem/src/index.ts:811–842`, symbol `parseSkillFile`.

This supports filesystem-backed skill loading. It does **not** establish automatic skill learning, durable user-preference curation or a semantic memory system. Those features remain unverified in this worker’s scope.

**MCP:** Harness has concrete stdio and Streamable HTTP transport construction:

`upstream/harness/packages/mcp/mcp-client/src/transport.ts:26–46`, symbol `createTransport`.

The stdio transport uses credential scrubbing as described at `transport.ts:1–18`.

An inspected MCP tool adaptation test checks execution identity, arguments, cancellation signal and structured results:

`upstream/harness/packages/mcp/mcp-client/tests/tool-definition.spec.ts:11–42`.

MCP transport existence does not establish that Superagent enables MCP by default, nor that a live MCP connection was tested here.

**Extensibility:** Concrete seams include the request-error waterfall, tool execution pipeline, native executor substitution and bundle-installed plugins. These establish implementation-level extension points, rather than relying on package counts.

## Regression execution record

Reviewed before execution:

- `upstream/harness/package.json`, including `test`, which normally runs `build:native-system` before Vitest.
- `upstream/harness/vitest.config.ts:1–22,199–252`.
- `upstream/harness/vitest.shared.ts:1–42`.
- Test setup scripts:
  - `scripts/test-proxy-environment.ts`
  - `scripts/test-dom-environment.ts`
  - `scripts/test-official-listing-guard.ts`
- Relevant test source, especially resume, approval, sandbox policy and MCP adaptation.

Invoked the prepared Vitest binary directly, deliberately avoiding native build/install setup:

```sh
cd upstream/harness &&
node --version &&
./node_modules/.bin/vitest run \
  packages/core/agent-loop/tests/resume.spec.ts \
  packages/core/agent-loop/tests/tool-order.spec.ts \
  packages/interaction/user-approval/tests/approval.spec.ts \
  packages/sandbox/sandbox-policy/tests/policy.spec.ts \
  packages/mcp/mcp-client/tests/tool-definition.spec.ts \
  --maxWorkers=1 --reporter=verbose
```

Declaration:

```text
verification = harness-regressions
verificationInputs = ['.']
```

Observed runtime: Node `v24.14.1`; Vitest `4.1.11`.

**Result limitations:**

- The returned log was truncated before its terminal summary.
- Numerous resume and approval test cases visibly passed.
- No failing test appeared in the visible excerpt.
- Final exit status, exact passed/failed/skipped counts and completion of all five selected files were **not captured**.
- A subsequent process listing showed no managed processes, but that is not a substitute for a final test result.
- Therefore this worker cannot honestly label the complete command successful or report an aggregate passing count.
- No missing prerequisite was reported in the visible excerpt. Native build artifacts, real-provider credentials, live MCP servers and OS sandbox prerequisites were not established as available.

## Outstanding obligations

1. Recover the original execution’s final receipt/log summary if available; otherwise retain the above test-result uncertainty.
2. Complete independent source tracing of subagent lifecycle, cross-session messaging, delegation-depth enforcement and ticket concurrency.
3. Complete application-level attribution of Superagent’s intake/policy/ticket implementation.
4. Do not claim automatic memory/skill learning, exactly-once external execution, live sandbox validation or a comparative model-performance winner from this audit.
5. Final report synthesis and saving `reports/superagent-vs-estacoda.md` remain the parent’s responsibility; this worker made no report write.
