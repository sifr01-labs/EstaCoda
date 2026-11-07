# Delegated work: execution, evidence and learning

A stopped execution is not a successful task, and a retained draft is not accepted evidence. These are separate decisions.

The scheduler preserves validated output as diagnostic results when final execution-limit accounting rejects it, including time, call, token and ancestor limits. Diagnostic publication retains the existing attempt fence, profile and result access checks. Cancellation and lost ownership do not authorize late publication. Diagnostics do not satisfy successful dependencies or establish complete research coverage. Runtime source-observation packets are separately identified from model drafts as described below. Invalid result contracts remain rejected.

The existing authorized parent/recovery path can inspect diagnostic references and verify sources before producing a new accepted result. A synthesis worker restricted to task-result reads cannot independently verify those sources. Preserving a draft therefore does not establish complete coverage or authorize more work; recovery needs appropriate existing authority and remaining budget.

Regression checks must exercise settlement after a valid result, not only provider-loop or tool completion. Delivery receipts establish transport or saved bytes, not research success.
## Shared provider allowance

Before each Task provider dispatch, the existing SQLite spend transaction also checks cumulative calls, tokens and elapsed time across the Step, Task and ancestors. In-flight requests reserve conservative estimated token exposure; incomplete usage retains that exposure. Actual usage and settlement checks remain authoritative because input token estimates are not exact.

Workers see the remaining shared allowance. Near exhaustion, the provider loop requests a qualified final answer without tools inside the existing allowance. This does not grant extra calls or accept unsupported coverage. Independent reads should be batched and test prerequisites checked early. Identical original/routed user messages are no longer duplicated; full research history is not silently discarded to save tokens.

Finalization and dispatch use the same conservative input estimate. The output allowance is bounded by the remaining tokens, with space for reasoning and the budget notice. A finalization request does not trigger ordinary tool-using completion repair. A host-identified textual citation correction may use the remaining allowance with tools disabled; it does not expand the budget. Fallbacks and text continuations still pass through admission; continuation merging retains the specific budget-denial reason. Actual usage can differ from estimates, so settlement remains authoritative.

## Learning after settlement

A foreground delegation handoff persists a pending observation instead of recording objective success. After all owned Tasks settle, reconciliation reads their status, failure classes and accepted/diagnostic result references. It creates idempotent learning evidence, then atomically replaces the pending handoff with a persisted review job in the existing learning store. Startup and later runtime activity reconcile interrupted handoffs; the scheduler invokes reconciliation after settlement. Profile, origin session, workspace and live authority must match. A changed skill definition cannot receive a refinement based on its old revision.

The background reviewer can read the observed skill's declared resources and the originating session's Task results. It has at most three model rounds and four scoped reads per round, with tools removed in the final round. It cannot execute commands or write arbitrary files. It returns an exact body patch through the existing proposal service. Existing approval, source ownership, stale-content, pinning, evaluation, snapshot and undo rules remain in force.

The reviewer prefers the session's last successful route when it remains configured, and can use configured fallbacks. Technical provider failure, invalid output, unavailable evidence, policy refusal and intentional abstention have different persisted outcomes. One provider-failure retry is eligible after a minute on a subsequent review trigger, within the existing daily limit; there is no unbounded retry timer. Reviews queued while another session is being reviewed are drained without borrowing its session authority.

## Practical limits

- Retaining a diagnostic draft does not repair missing tests or make its claims accepted. A reader-only synthesizer cannot independently validate an upstream dependency failure.
- Conservative token estimation can stop research before the actual token ceiling. It prevents avoidable overshoot but does not guarantee sufficient coverage within every allowance.
- Batching guidance and removal of duplicate user text reduce avoidable replay; this change does not implement semantic compression during every tool round.
- A persisted skill correction is an applied adaptation. It is not evidence of improved future task performance without a separate, matched evaluation.
- Per-worker skill-use telemetry describes the worker turn. The parent observation with `settledTasks` is the authoritative objective outcome for delegated learning.

Security review: execution ceilings and authority are not widened. New review access is read-only and bound to existing profile/session/workspace/result checks. Diagnostic drafts retain credential sanitization and attempt fencing; they cannot satisfy successful dependencies. Tests cover concurrent reservations, ancestor budgets, late results, reconciliation replay, authority revocation and cross-workspace exclusion.


## Foreground partial delivery and review recovery

A rejected foreground completion can deliver its sanitized candidate beneath a runtime-authored incomplete status and an explicit **Partial draft — not accepted** label. The candidate's claims are not promoted to verified results. Execution outcome, unresolved checks, file verification and learning outcome remain unchanged. The foreground and durable worker paths share the same disclosure eligibility: actual privileged output and local mutations without a finished dispatch receipt are withheld; denied-only work is not republished. Finished local calls with uncertain effects may retain sanitized diagnostics carrying a runtime-authored uncertainty notice. That disclosure neither settles the effects nor authorizes a retry. Credential redaction and reasoning removal apply before disclosure. Raw provider final text remains suppressed so adapters cannot bypass this projection.

Review jobs persist profile, originating session and workspace identity. Startup resumes only matching jobs under current policy and authority. Removing a settled handoff and inserting its review obligation is one locked write; no in-memory scheduling gap can erase that obligation. Job generations prevent an old review from acknowledging newer work. Claims expire after ten minutes and use unique owner tokens; an interrupted owner cannot overwrite a newer claim's result. Reviews have a two-minute cancellation deadline, retain the existing daily allowance and at most two attempts per candidate, and reconcile an already-created proposal rather than creating another. An interrupted or temporarily unavailable review is retried on a later matching runtime/review trigger, not by an unbounded timer. Recovery does not itself authorize promotion.

The supervisor keeps a workspace runtime alive while a bounded review is active. Explicit shutdown still cancels it and leaves pending work on disk. This is recoverable work, not a promise that review proceeds while the application is stopped. Provider cancellation remains cooperative.

Tool selection prioritizes discovery, core tools, explicit prerequisites, selected skill requirements and relevant policy tools before broadly routed optional schemas. Relevant delegation is ranked ahead of optional configuration clutter when it was already eligible for selection. This does not force delegation or expose unavailable tools. Discovery returns a concrete exposure-request input for eligible omitted tools; the existing catalog revalidation, schema ceilings and execution authorization remain mandatory.

Regression coverage includes qualified foreground delivery with an unresolved command check, missing file readback remaining unverified, shared credential suppression and qualified uncertainty disclosure, settlement-to-review restart, revoked authority and workspace mismatch, expired claims and stale-owner writes, supervisor disposal and saturated schema recovery.


## Command waits and interrupted research

With managed processes available, `terminal.run.waitMs` controls only the initial observation wait (0–30 seconds, bounded by the configured command wait). A still-running command returns its existing process ID; `process.logs` collects its eventual exit. Do not restart it to collect output. Omission/null retains the default managed wait. `timeoutMs` remains an intentional hard execution deadline and waits for termination/exit; the two non-null fields are mutually exclusive. Invalid inputs are rejected before dispatch. Non-managed runtimes retain their bounded execution path and cannot accept observation waits. Parent deadlines, cancellation, execution ownership and hardline policy remain enforced.

Both command modes use the existing process manager when available. Explicit deadline termination retains the process record and does not turn a timed-out check into a pass. An interrupted local call can leave uncertain filesystem effects even when process cleanup completed. The executor can preserve an eligible sanitized candidate as an unaccepted diagnostic; the scheduler must not discard that diagnostic solely because retry remains unsafe. Missing execution receipts and privileged output remain ineligible.

An uncertain step remains waiting for operator review, without automatic replay. The scheduler may finish independent steps only when their enforced authority forbids every mutating/privileged risk class and further child creation. Dependents and new mutating steps remain blocked in the shared workspace. The guard is rechecked at selection, claim and start. Once independent reads drain, the Task waits for review; it is not marked completed. This does not infer workspace isolation from a worker's title or idempotency label.

Repository research acceptance requires a successful source read and a matching observed workspace-relative citation. Discovery/search is optional when the path is known. Missing or uncited reads still fail acceptance with actionable feedback. This verifies source provenance, not the semantic truth of every claim.

Risk note: this change broadens disclosure of sanitized local diagnostics, not execution authority or automatic retries. Synthesis still cannot treat model diagnostic drafts as accepted coverage. Real command termination and cancellation tests complement scheduler tests for retained failure status, blocked writes, and independent read continuation.

## Partial source observations and citation correction

An incomplete research worker may publish two distinct diagnostic results through the existing fenced result service: its sanitized unaccepted draft, and a runtime-generated JSON packet of authorized source observations. The latter uses the reserved `application/vnd.estacoda.research-observations+json` MIME type and `json` kind; model-authored JSON and artifacts cannot acquire that identity through result capture.

Packets contain at most 32 sanitized excerpts (2,400 characters each), source paths or observed URLs, tool-call identifiers, original output hashes, explicit truncation/omission information, settled check exits when available, and unresolved verification labels. They contain no inferred worker conclusions. Denied reads, failed retrievals, uncertain observations, privileged disclosure and private absolute file paths are excluded. Source content remains untrusted data, including any embedded instructions.

When all dependencies have settled, an eligible packet can enable partial synthesis even if no worker completed successfully; ordinary diagnostic prose cannot. Synthesis receives explicit packet references and must read their complete hash-matching content through the ordinary authorized result reader. Only packets from assigned dependencies in the active plan qualify. Synthesis may derive narrowly cited findings from the captured excerpts while retaining their limits. Draft claims, complete task coverage and failed tests are not promoted. Existing failed step status and partial task settlement remain unchanged. This reuses captured observations; it does not grant the synthesizer new source-access or execution permissions.

Live-source feedback lists exact unmatched URLs. When existing observations suffice for a textual correction, the same bounded repair loop removes tool exposure and refuses tool execution. A correction may use remaining finalization allowance but never bypasses token/call/time reservations, cancellation or authorization boundaries. Validation events record why repair was skipped (budget finalization, iteration/repair limits, nonrepairable feedback, cancellation or authorization). Abbreviated URLs are not silently exempted from citation validation.

Security review focus: source excerpts cross from incomplete workers to synthesis, so test source provenance, complete-page/hash matching, dependency/plan identity, credential redaction, artifact impersonation, unresolved check retention and unchanged failure states. This contract verifies provenance and completion facts, not the truth of every model-authored claim.
