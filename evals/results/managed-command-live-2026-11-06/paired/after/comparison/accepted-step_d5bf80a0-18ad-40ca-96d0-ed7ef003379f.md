The pinned harness supplies the agent loop and runtime services. Four targeted suites passed (212 tests); delegation, native confinement, and bundle wiring remain partly unverified.

## Scope and revision

- Assigned scope: **`harness-runtime-source-and-tests`**; underlying runtime in `upstream/harness`, not the superagent implementation.
- `UPSTREAM.json:3` pins harness to **`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`**.
- This is the manifest-declared revision. I did **not** independently verify Git HEAD or working-tree cleanliness.
- No network access, installs, setup/deploy scripts, or source edits were used. The requested final synthesis file was **not written**, consistent with the research-worker instruction.

## Source findings

### 1. Agent lifecycle and request/tool loop

The runtime owns a substantive agent driver rather than just an SDK wrapper.

**Implementation:** `upstream/harness/packages/core/agent-loop/src/agent.ts`

- **`ReactLoopAgent`**, beginning at line 111, owns a session, model, inbox, scoped context, phase state, runtime-context projection, and assistant-stream state.
- **Input and cancellation:** lines 171–198 implement `send`, `followup`, `steer`, `inject`, and `cancel`. Follow-ups target the next turn; steering targets the next step; injection does not itself wake the driver. Cancellation optionally clears the inbox and aborts the active phase.
- **Maintenance exclusion:** `runMaintenance`, lines 200–222, rejects maintenance while other work is active, owns its abort controller, and restores idle state before replaying pending wakeups.
- **Driver:** `kick`, lines 268–281, repeatedly calls `turn()`, contains already-reported failures/cancellation at the driver boundary, and restores idle state.
- **Step admission:** `preStep`, lines 283–317, claims queued input, requires a selected provider/model, resolves the step’s tool set, assembles the system prompt, and runs the `agent/pre-step` waterfall. Admission is disposed on rejection or failure.
- **Turn execution:** `turn`, lines 327–432, records turn/step boundaries and repeatedly executes admitted steps. It disposes each step’s tool admission after execution, preserves a max-token outcome across subsequent steps, and permits a turn-stopping hook before final termination.
- **Streaming and tool dispatch:** `step`, lines 435–611, binds the request, streams through `AssistantStreamAttempt`, durably settles assistant output, distinguishes completion/max-token outcomes, and extracts tool-call blocks. At lines 590–609 it calls the tools service with the agent, logged turn/step, resolved tool admission, cancellation signal, and configured parallelism. Additional tool context is queued for the next step; a concluding tool result can end the turn.
- **Request reconstruction:** `prepareRequest` and `buildRequest` begin at lines 613 and 656. Their full bodies were not inspected in the retained evidence; therefore the complete configuration/header reconstruction semantics remain a gap.

**Recovery visible in this loop:**

- `turn`, lines 363–390, observes session events using `ToolCallRecovery`; if a step fails, it appends missing tool results before rethrowing, and aggregates a second error if recovery itself cannot be recorded.
- `step`, in the inspected lines 435–611, durably settles interrupted assistant content or an assistant attempt when streaming fails/cancels.
- The `agent/request-error` waterfall can request a retry; absent a retry decision, the driver throws `LlmError`.

These mechanisms establish runtime-owned orchestration and recovery code; they do not establish autonomous task success or model quality.

### 2. Tool dispatch, denial, concurrency, and executor ownership

**Service/executor seam:**

- `upstream/harness/packages/core/tools/src/index.ts:375–376`, **`ToolsService.execute`**, delegates to the selected executor.
- `upstream/harness/packages/core/tools/src/index.ts:323–346` documents and implements retaining an unavailable executor selection rather than falling through to another executor.
- `upstream/harness/packages/core/tools/src/executor.ts:63–85`, **`ToolExecutor`**, specifies complete-batch execution, model-order results, cancellation/draining obligations, logging, and concurrency override semantics.
- `executor.ts:88–101` defines **`ToolBatchExecutionError`** carrying partial committed results and **`ToolExecutorUnavailableError`**.

**Execution enforcement:**

- `upstream/harness/packages/core/tools/src/pipeline.ts:190–239`, **`ToolExecutionPipeline.prepare`**, evaluates execution policy and guards before dispatch. Lines 213–222 turn a denial into an error result rather than invoking the tool.
- `pipeline.ts:258–285`, **`dispatchToolBody`**, invokes `tool.execute`, constructs the result, handles cancellation after body completion, converts thrown errors to tool error results, and disposes the fused signal.
- `pipeline.ts:539` validates detached successful output against its declared JSON schema.
- `upstream/harness/packages/core/tools/src/contracts.ts:72–81` makes concurrency safety opt-in: omission, exceptions, non-`true` responses, and invalid cases do not opt a call into parallel execution.

**Scheduler:**

- `upstream/harness/packages/core/tools/src/batch.ts:50`, **`executeToolBatch`**, is the batch scheduler.
- `batch.ts:81` distinguishes a parallel group from an exclusive call.
- `batch.ts:117–192`, **`runGroup`**, contains the rolling pool and reclassifies later calls before starting them.
- The executor contract says an explicit positive-integer `maxParallelToolCalls` overrides executor configuration; this applies to concurrency-safe root calls, with program subcalls separately limited (`executor.ts:19–27, 74–85`).

The scheduler locations were observed through source search; its complete implementation was not read. No dedicated concurrency suite was run.

### 3. Permission and sandbox boundaries

The inspected source separates tool admission/denial from process confinement; neither should be conflated with a universally enabled security boundary.

- `upstream/harness/packages/sandbox/sandbox-policy/src/index.ts:1–15` identifies the policy owner for deployment fallbacks, per-session sandbox mode, workspace-write root, and extra writable directories. It also describes contributing the resolved policy to request-time runtime context.
- Tool execution denial is enforced inside the pipeline described above, not merely by hiding schemas.
- I did **not** finish reading the user-approval and permission-preset implementations. Approval defaults, persistence, delegation inheritance, and bypass behavior therefore remain unverified.

**Local sandbox provider:**

`upstream/harness/packages/sandbox/sandbox-local/src/index.ts`

- **`LocalSandboxProvider`**, line 252, owns local runner selection.
- Lines 68–91 implement bounded functional probes for bwrap and Seatbelt.
- Lines 233–242 define runner-specific failure rules; these distinguish launcher failure from ordinary command output, with exit-gated handling for Landlock and Windows ACL.
- **`selectRunner` / `chainVerdict`**, lines 506–523, fail closed if no candidate is usable. Multiple candidates are probed in chain order; a sole candidate is selected without arbitration, with execution-time refusal still expected to fail closed.
- **`probeRunner`**, lines 527–550, handles bwrap, Landlock, Seatbelt, and Windows ACL. The code distinguishes full enforcement from partial enforcement.
- Lines 527–533 explicitly describe Windows ACL’s partial boundaries, including hard-link and unconfined-read limitations; Landlock enforcement can vary by ABI.
- A configured `runnerCommand` asserts full enforcement and bypasses built-in selection/probing; its failure-signature contract is documented at lines 45–63.

**Important limitation:** the policy test run below does **not** prove actual OS confinement. No real sandbox runner or native prerequisite probe was executed, so native availability is **unknown**, not “available” or “missing.”

### 4. Sessions, persistence, and recovery

**Storage contract:** `upstream/harness/packages/session/session-persistence/src/index.ts`

- Lines 1–5 define event-log storage with non-replayable session-header metadata kept separately.
- Lines 86–101 define fork-inherited prefix metadata and validated session inspection.
- Lines 127–144 specify contiguous append-only events, torn-tail exclusion/truncation on the write path, fail-closed current-format validation, best-effort append versus a durability-barrier `flush`, and deferred physical materialization.
- **`SessionPersistence.create`**, lines 153–159, returns an owned write handle.
- **`SessionPersistence.open`**, lines 161–175, distinguishes read access from atomic single-writer ownership and rejects an already-owned write session.

These are service contracts, not a complete backend implementation audit. JSONL generation publication, leases, fsync boundaries, and cross-process crash recovery were not fully traced. The executed migration-refusal suite supplies narrower observed evidence about refusing/preserving invalid or unexpected stored content.

### 5. Delegation

The delegation manager source inspected was incomplete.

- `upstream/harness/packages/subagent/subagent/src/manager.ts:84–100`, **`MaterializeInputs`**, distinguishes local child materialization from external backend execution.
- Lines 88–92 state that cold resume loads persisted delegation-policy events instead of recapturing the parent’s current policy.

This supports the existence of persisted local/external delegation machinery, but **does not complete** a trace of child creation, depth limits, cancellation propagation, result delivery, concurrency limits, or external backend isolation. No delegation tests were run.

### 6. Provider support: implementation, not live availability

`upstream/harness/packages/llm/llm-pi-ai/src/provider.ts`

- Lines 5–12 describe reusing catalog providers unless the route overrides their wire protocol, preserving provider-owned implementations such as Bedrock’s separate entry.
- Lines 14–17 place credential resolution in the harness before passing credentials into pi-ai streaming options.
- **`PROTOCOLS`**, lines 47–51, explicitly provides hand-declared route implementations for:
  - `openai-completions`
  - `openai-responses`
  - `anthropic-messages`
- Lines 35–45 explain why explicit override configuration does not express Bedrock, Vertex, Azure, or Codex authentication requirements. Catalog routes may still reach protocols through their own providers.
- **`supportedProtocols`**, lines 61–63, exposes the explicit protocol table.

This is pinned repository capability evidence only. It does not verify current service availability, model versions, regions, credentials, retirement status, or successful remote inference. No provider network call was attempted.

## What is inherited versus bundle-implemented?

The audited harness contains the implementations for the loop, tool execution service/pipeline, scheduling, persistence contracts, sandbox policy/provider, provider adaptation, and delegation machinery identified above.

Its shared base bundle is explicitly composition-oriented:

- `upstream/harness/packages/bundle/base/src/index.ts:1–9` says the package’s substance is `cordis.patch.yml`, selected through its manifest’s `dsh.bundle.patch`; the module exports no runtime API.

**Safe synthesis boundary:** a dsh-superagent bundle that selects these harness plugins inherits those runtime mechanisms; merely assembling them is not implementing a new agent loop or sandbox.

**Outstanding evidence:** I did not inspect dsh-superagent’s composition or its patch against the harness. Exact activated plugins, overridden defaults, additional guards/tools, and bundle-specific implementations must be established by the corresponding bundle-source audit. Do not treat every harness capability as enabled in dsh-superagent.

## Executed tests

### Configuration review

Reviewed the existing harness package/test configuration before execution:

- `upstream/harness/package.json` test scripts and supporting scripts.
- `upstream/harness/vitest.config.ts:137–142`: normal suite inclusion targets existing `*.spec.{ts,tsx}` files.
- `vitest.config.ts:169–182`: process-bound suite exceptions.
- `vitest.config.ts:199–206`: source-path/decorator plugins and test setup files.
- `upstream/harness/vitest.shared.ts:15–39`: standard-decorator source transform.

Used the prepared local Vitest binary directly; no package installation, lifecycle scripts, build, or deployment step was run.

### Exact command

```sh
cd upstream/harness && node --version && node_modules/.bin/vitest run packages/core/agent-loop/tests/cancel.spec.ts packages/sandbox/sandbox-policy/tests/policy.spec.ts packages/llm/llm-retry/tests/transport-recovery.spec.ts packages/session/session-persistence-jsonl/tests/migration-refusal.spec.ts --maxWorkers=1
```

Launched through `terminal_run` with **`waitMs=1000`**, then polled `process_logs` to completion.

| Existing suite | Result |
|---|---:|
| `packages/core/agent-loop/tests/cancel.spec.ts` | 44 passed |
| `packages/session/session-persistence-jsonl/tests/migration-refusal.spec.ts` | 136 passed |
| `packages/llm/llm-retry/tests/transport-recovery.spec.ts` | 8 passed |
| `packages/sandbox/sandbox-policy/tests/policy.spec.ts` | 24 passed |
| **Total** | **4 files passed; 212 tests passed** |

- **Exit status:** `0`, signal `null`.
- **Runtime:** Node `v24.14.1`; Vitest `v4.1.11`.
- **Reported duration:** `14.06s`.
- **Failed tests:** none in this bounded selection.
- **Warnings:** repeated `vite-tsconfig-paths` warnings recommending Vite’s native `resolve.tsconfigPaths`.

Discriminating cases visible in the test output included stalled/abort-unobserving response-body timeout recovery, migration/native-reopen preservation of unexpected and prototype-sensitive fields, and a retained version watermark. These are test-harness observations, not live-provider checks.

## Limitations and outstanding obligations

1. The requested approximate read-call budget was exceeded during evidence gathering; no further tool work was performed after the finalization instruction.
2. Complete request reconstruction, permission approvals/presets, JSONL durability/locking implementation, and delegation lifecycle remain incomplete.
3. Native prerequisites were not probed. Prepared dependencies were supplied without lifecycle scripts; passing these suites cannot establish native addon, sandbox runner, terminal, or external-agent readiness.
4. No actual confined process, cross-process crash recovery, real provider inference, or dsh-superagent end-to-end run was tested.
5. No agent/model performance conclusion follows from the **212** passing tests.
6. The parent synthesis must reconcile bundle wiring and save/read back `reports/superagent-estacoda-comparison.md`; that deliverable remains outside this worker’s completed actions.
