EstaCoda’s fixture passed 288 targeted tests, including recovery, concurrency, spend denial and review gates. This supports runtime safeguards, not comparative coding performance.

## Scope and provenance

- **Scope:** `estacoda-runtime`, repository inspection and bounded native deterministic tests only. No live-source claims or web verification.
- **Observed fixture HEAD:** `5a9f397a8063d6235157282c4bda77e20c93c71c`, from executed `git rev-parse HEAD`.
- **Subject baseline:** `MANIFEST.json` declares `bed689970f442caa9cf44432eeeec30bed9f05de` and an `updatedSourceHashes` map covering 21 files. These include provider-spend policy/controller, scheduler, delegation tests, learning, and runtime wiring. **Do not present this as an unmodified checkout of that baseline.**
- `MANIFEST.json`’s `scope` describes a prepared experimental fixture: equal upstream/dependency preparation, controlled token-ceiling stress, isolated learning skill, deliberate setup/policy fault injection, and no web or Telegram transport. Its statement about real Codex execution describes fixture provenance—not the execution of the native tests below.
- This workspace is **not evidence of a deployed service**, production operational history, current external-provider health, or latest upstream release.
- Inspected `package.json` scripts before testing. `test` and `test:node` use `vitest run --config vitest.node.config.ts`; the benchmark scripts are separate. The configured environment is Node, with isolated state initialization through `src/test/vitest-setup.ts:1–4`.
- No source edits, installation, dependency changes, configuration-file inspection, or credential reads were performed. Tests used the pre-existing dependencies. Manifest hashes were observed, not independently recomputed.

## Executed test receipts

Both commands were bounded to 30 seconds and declared `verificationInputs: ["."]`. Both returned successful execution; neither produced a failure or prerequisite error.

### A. Durable execution, authorization, budgets, learning and memory

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts src/tasks/sqlite-provider-spend.test.ts src/tasks/provider-spend-cross-process.test.ts src/delegation/durable-delegation-service.test.ts src/delegation/toolset-security.test.ts src/providers/provider-spend-enforcement.test.ts src/skills/skill-lifecycle.test.ts src/memory/memory-curation-service.test.ts --reporter=dot
```

- **Exit:** 0 / successful tool receipt.
- **Result:** 8 test files passed; **178 tests passed**.
- **Vitest:** 4.1.6.
- **Reported wall duration:** 7.89 seconds.
- **Failures:** none.

### B. Provider routing/fallback and channel state

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/providers/provider-executor-route.test.ts src/providers/provider-executor-fallback.test.ts src/channels/channel-state-recovery.test.ts src/channels/adapter-capability.test.ts --reporter=dot
```

- **Exit:** 0 / successful tool receipt.
- **Result:** 4 test files passed; **110 tests passed**.
- **Reported wall duration:** 462 milliseconds.
- **Failures:** none.

**Total: 12 distinct files, 288 passing tests.** This is a targeted test-suite result, not a coding benchmark, throughput comparison, or security certification. No full-suite, live-provider, live-channel, Docker, or controlled comparative coding run was attempted.

## Discriminating findings

### 1. Durable tasks have explicit recovery and acceptance semantics

The executed scheduler suite tests:

- Dependency ordering and settling only after durable result acceptance: `src/tasks/task-scheduler.test.ts:100`.
- Expired/superseded dispatch grants and host fencing races: `:226`, `:249`.
- Competing schedulers and cross-owner concurrency boundaries: `:288`, `:504`.
- Deterministic retry backoff: `:552`.
- **Uncertain non-idempotent work pauses for operator review**, rather than blindly retrying: `:582`.
- Atomic publication retry without stale/duplicate results and rollback on invalid settlement: `:717`, `:780`.
- Cancellation rejecting late success: `:841`.
- Restart recovery of an expired retry-safe attempt: `:1201`.
- Reusing a queued crash-boundary attempt rather than creating duplicate dispatch: `:1363`.
- Rejecting settlement after lease expiry: `:1381`.

**Practical implication:** There is tested lifecycle machinery beyond “launch several agents and collect strings.” The strongest comparison dimensions are fenced ownership, safe retry classification, durable acceptance and publication—not raw agent count. These tests do **not** establish universal exactly-once external side effects.

### 2. Delegation is authority- and ancestor-budget-constrained

Implemented source surfaces include `DurableDelegationService.inspectAccess` in `src/delegation/durable-delegation-service.ts:202–203`, and `resolveChildToolAccess` / `resolveTaskStepToolAccess` in `src/delegation/toolset-security.ts:52`, `:96`.

Executed cases establish:

- Explicit read-only ceiling preserved: `src/delegation/toolset-security.test.ts:8`.
- Parent-visible editing/execution inherited without granting sensitive capabilities: `:16`.
- Non-parent-visible tools rejected: `:33`.
- Requested tools and toolsets intersected: `:60`.
- Blocked exact names/prefixes remain blocked even when requested: `:80`.
- Delegation available only to eligible orchestrators below spawn depth: `:100`.

Additional executed durable-delegation cases reject:

- Child creation after parent lease expiry: `src/delegation/durable-delegation-service.test.ts:912`.
- Repeated child calls multiplying the parent step ceiling: `:967`.
- Child redefinition of root monetary scope: `:1000`.
- Concurrent reservations overspending remaining ceiling: `:1048`.
- Child expansion of root live concurrency: `:1167`.
- Descendant dispatch after ancestor deadline: `:1200`.
- Forbidden runtime children and untrusted workspaces: `:1325`, `:1350`.

**Boundary:** This is evidence for the tested runtime authorization paths, not proof against all malicious-tool or sandbox escapes.

### 3. Provider spend enforcement is durable admission control, not just token reporting

`SQLiteProviderSpendController` is implemented in `src/tasks/sqlite-provider-spend.ts:66`; `reserve` begins at `:105`, and the controller uses `begin immediate` at `:1062`. `prepareProviderSpend` is in `src/providers/provider-spend-policy.ts:24`.

Executed checks include:

- Zero-spend session denied **before adapter entry**: `src/providers/provider-spend-enforcement.test.ts:163`.
- Unknown pricing fails closed when an applicable limit exists: `:179`.
- Unbounded request denied before dispatch: `:205`.
- Parallel reservations prevent session oversubscription: `:227`.
- Adapter exception after dispatch retains uncertain reserved capacity: `:253`.
- Missing controller for attributed execution fails closed: `:346`.

Durability/cross-process checks include:

- Atomic multi-scope reservation: `src/tasks/sqlite-provider-spend.test.ts:100`.
- Pre-dispatch release versus uncertain dispatch retention: `:212`.
- Lease-expired settlement rejected: `:314`.
- Synthesis capacity protected: `:401`, `:439`.
- Tampered balances/policy fail closed: `:684`.
- Only one process wins final available capacity: `src/tasks/provider-spend-cross-process.test.ts:79`.
- Live heartbeating dispatch not reclaimed: `:98`.
- Capacity recovered conservatively after process crash: `:134`.

**Qualification:** These checks validate local accounting/admission behavior, not invoice reconciliation or correctness of every provider’s pricing/usage metadata.

### 4. Learning is neither wholly manual nor unrestricted self-modification

Executed lifecycle tests demonstrate:

- Evidence-linked drafts without mutating live skills: `src/skills/skill-lifecycle.test.ts:77`.
- Correction/receipt-based drafting with approval gates: `:107`.
- Rejection of stale drafts and authority expansion even with approval: `:181`.
- Unexecuted assertions not accepted as passing checks: `:206`.
- Cancellable background review with retryable candidate: `:237`.
- Serialized observations/draft claims: `:257`.
- Provenance and invalidation of earlier passing evidence: `:272`.
- **Narrow supported correction can automatically activate, record snapshot, notify and undo:** `:313`.
- Frontmatter/higher-risk changes are not automatically eligible: `:358`.

Source reinforces asynchronous review and authority revalidation: `src/skills/skill-learning.ts:245–268`, `:409`, `:439–448`.

**Accurate comparison wording:** “Evidence-linked learning with policy-gated promotion and constrained automatic correction,” not “all changes require human approval” or “unrestricted autonomous learning.”

### 5. Memory has explicit apply/review and retry boundaries

Executed `src/memory/memory-curation-service.test.ts` cases cover:

- Explicit low-risk facts auto-applied with audit trail: `:34`.
- Cleanup proposed without memory mutation: `:120`.
- Review-mode candidates queued without mutation: `:171`.
- Extraction failure and mutation failure do not advance the cursor: `:296`, `:330`.
- Immutable finalization cutoff: `:410`.
- Transcript/cutoff mismatch fails closed: `:441`.

This supports durable curation workflow claims, **not measured long-horizon recall quality**.

### 6. Multi-provider routing and integrations exist, but “configured” is not “live healthy”

Repository wiring registers catalog, OpenAI Responses and OpenAI-compatible adapters at `src/runtime/create-runtime.ts:1854–1904` (observed through file grep; a subsequent bounded read did not return that body).

Executed fallback cases verify explicit fallback ordering and distinctions between empty content, tool calls and reasoning metadata: `src/providers/provider-executor-fallback.test.ts:140`, `:179`, `:230`, `:295`.

Executed channel cases cover cross-instance handoffs, corrupt/cross-profile state refusal and OS-process serialization: `src/channels/channel-state-recovery.test.ts:12`, `:34`, `:50`, `:72`.

Adapter tests encode Telegram, Discord, email and experimental WhatsApp traits/configuration gates: `src/channels/adapter-capability.test.ts:54–165`. Even the test’s `live_proven` label at `:5` is **static repository metadata, not a live transport check performed here**.

## Guidance for the parent comparison

The strongest supported EstaCoda positioning is a **persistent agent runtime with tested ownership, recovery, admission-budget and policy boundaries**. Whether it outperforms another system at coding, research quality, latency, cost or real-world reliability remains unmeasured.

Do not extrapolate these 288 passes into a score against superagent/Harness. Compare their source mechanisms against the specific boundaries above, and explicitly label missing counterpart evidence as unknown. No claim about the other snapshots, their launch identity, upstream freshness or deployed behavior is established by this worker’s scope.
