# Delegated work: execution, evidence and learning

A stopped execution is not a successful task, and a retained draft is not accepted evidence. These are separate decisions.

The scheduler preserves validated output as diagnostic results when final execution-limit accounting rejects it, including time, call, token and ancestor limits. Diagnostic publication retains the existing attempt fence, profile and result access checks. Cancellation and lost ownership do not authorize late publication. Diagnostics do not satisfy successful dependencies or research coverage. Invalid result contracts remain rejected.

The existing authorized parent/recovery path can inspect diagnostic references and verify sources before producing a new accepted result. A synthesis worker restricted to task-result reads cannot independently verify those sources. Preserving a draft therefore does not establish complete coverage or authorize more work; recovery needs appropriate existing authority and remaining budget.

Regression checks must exercise settlement after a valid result, not only provider-loop or tool completion. Delivery receipts establish transport or saved bytes, not research success.
## Shared provider allowance

Before each Task provider dispatch, the existing SQLite spend transaction also checks cumulative calls, tokens and elapsed time across the Step, Task and ancestors. In-flight requests reserve conservative estimated token exposure; incomplete usage retains that exposure. Actual usage and settlement checks remain authoritative because input token estimates are not exact.

Workers see the remaining shared allowance. Near exhaustion, the provider loop requests a qualified final answer without tools inside the existing allowance. This does not grant extra calls or accept unsupported coverage. Independent reads should be batched and test prerequisites checked early. Identical original/routed user messages are no longer duplicated; full research history is not silently discarded to save tokens.

Finalization and dispatch use the same conservative input estimate. The output allowance is bounded by the remaining tokens, with space for reasoning and the budget notice. A finalization request does not trigger additional completion-repair rounds. Fallbacks and text continuations still pass through admission; continuation merging retains the specific budget-denial reason. Actual usage can differ from estimates, so settlement remains authoritative.

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

A rejected foreground completion can deliver its sanitized candidate beneath a runtime-authored incomplete status and an explicit **Partial draft — not accepted** label. The candidate's claims are not promoted to verified results. Execution outcome, unresolved checks, file verification and learning outcome remain unchanged. The foreground and durable worker paths share the same disclosure eligibility: uncertain effects and actual privileged output are withheld; denied-only work is not republished. Credential redaction and reasoning removal apply before disclosure. Raw provider final text remains suppressed so adapters cannot bypass this projection.

Review jobs persist profile, originating session and workspace identity. Startup resumes only matching jobs under current policy and authority. Removing a settled handoff and inserting its review obligation is one locked write; no in-memory scheduling gap can erase that obligation. Job generations prevent an old review from acknowledging newer work. Claims expire after ten minutes and use unique owner tokens; an interrupted owner cannot overwrite a newer claim's result. Reviews have a two-minute cancellation deadline, retain the existing daily allowance and at most two attempts per candidate, and reconcile an already-created proposal rather than creating another. An interrupted or temporarily unavailable review is retried on a later matching runtime/review trigger, not by an unbounded timer. Recovery does not itself authorize promotion.

The supervisor keeps a workspace runtime alive while a bounded review is active. Explicit shutdown still cancels it and leaves pending work on disk. This is recoverable work, not a promise that review proceeds while the application is stopped. Provider cancellation remains cooperative.

Tool selection prioritizes discovery, core tools, explicit prerequisites, selected skill requirements and relevant policy tools before broadly routed optional schemas. Relevant delegation is ranked ahead of optional configuration clutter when it was already eligible for selection. This does not force delegation or expose unavailable tools. Discovery returns a concrete exposure-request input for eligible omitted tools; the existing catalog revalidation, schema ceilings and execution authorization remain mandatory.

Regression coverage includes qualified foreground delivery with an unresolved command check, missing file readback remaining unverified, shared credential/uncertain-effect suppression, settlement-to-review restart, revoked authority and workspace mismatch, expired claims and stale-owner writes, supervisor disposal and saturated schema recovery.
