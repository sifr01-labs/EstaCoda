Both can retain research after local read errors. EstaCoda applies a narrow evidence gate; Hermes may label partial text completed. Neither establishes exhaustive coverage.

## Scope and source identity

This report synthesizes two accepted source-investigation results, one per codebase; they are not independent corroboration of each other.

`MANIFEST.json` identifies the EstaCoda baseline as `c7d656c614d9acf5b9649148fa2d6d6e8c5b3c4b` and the supplied executor snapshot by SHA-256 `ceaa55c1af806671d24d4556047f70a285db7db44d723b44c6b2ee5e4464331f`, without an “after” revision. Hermes is pinned to `5e7c2b254d414e4e25105231f818f385fee67469`. These are manifest declarations, not independently recomputed identities or claims about current upstream behavior.

## EstaCoda: narrow tolerance, separate acceptance checks

**A local read error is not automatically fatal.** In `estacoda/src/tasks/agent-step-executor.ts:925–947`, `hasUnrecoveredToolFailure` excludes failures recognized by `isLocalResearchReadLimitation`. The exception requires a worker performing repository-required research, a research contract, an execution decision of `allow`, risk class `read-only-local`, an eligible inspection/read/search tool, no recorded side effects, and a reason other than `unavailable`.

This is not blanket error suppression: denial, unavailable capability, or uncertain side effects cannot qualify through this exception. Conversely, an eligible failed read need not receive an identical successful retry before research can proceed.

**Acceptance still requires successful evidence.** `researchCompletionFailure` runs grounding, unrecovered-failure detection, and `researchEvidenceFailure`; it is installed as a completion validator and checked again during settlement (`agent-step-executor.ts:318–342,446–449,711–721`). For repository research, the evidence gate requires successful authorized discovery, a successful `file.read` with an observed path, and a report reference matching an observed path (`:724–764`).

That is **minimum provenance, not exhaustive coverage**. One observed and cited file does not prove that every assigned source or symbol was inspected. The live-source table machinery does not automatically strengthen repository-only work: `requiresSourceTable` and `groundResearchResult` in `estacoda/src/tasks/research-result-evidence.ts:14–22` condition that machinery on live-source research.

**Text availability remains separate from success.** Settlement handles approval/security/provider failures and abnormal termination before returning success after validation and `captureResults` (`agent-step-executor.ts:377–474`). `safeDiagnosticOutput` can retain read-only failed-attempt prose, explicitly without accepting it as the Step result (`:476–495,906–921`). Accepted reports receive a limitation notice through `researchReadLimitations`, identifying failed tool types and warning that failures are not evidence (`:450–458,942–947`).

## Hermes: retained text is not verified completion

In `hermes/tools/delegate_tool_child_run.py:565–630`, `_build_tool_trace` marks tool outputs as errors or successes, but `_build_result_entry` does not use those trace statuses to decide delegation status. Similarly, `run_tool_round` has no general rule that any tool error fails the run (`hermes/agent/turn_tool_round.py:101–128,170–238`). A read failure therefore need not permanently invalidate the child’s output.

**Structured failure does override prose.** `_build_result_entry` prioritizes interruption, then truthy `failed` or `error`, before classifying ordinary output (`delegate_tool_child_run.py:595–670`). Nonempty explanatory text cannot disguise an explicitly failed run.

However, absent structured failure, usable text can produce `status="completed"` even when the child’s `completed` flag is false; Hermes then exposes `exit_reason="max_iterations"` and `truncated=true` (`:621–649`). Consumers must not equate this status with normal task completion.

Schema validity is another separate verdict. `_validate_child_output_schema` permits one corrective retry; persistent invalidity produces `schema_valid=false` and a separate `schema_note`, rather than necessarily failing delegation (`:520–563,672–686`). Despite a nearby comment, implementation does **not** prefix the summary with that warning. A consumer reading only status and summary can miss it.

Durability is also distinct from authorization: `run_tool_round` stops before dispatch if canonical pre-execution persistence fails, and stops after tool-result persistence failure (`turn_tool_round.py:129–153,176–183`). Full authorization machinery was not traced. Nor does `apply_stop_gates` establish research coverage: its verification nudges can retain a candidate as `pending_verification_response`, but the inspected implementation is not a required-source validator (`hermes/agent/turn_stop_gates.py:36–118,134–223`).

## Recommended small acceptance policy

Keep four explicit verdicts:

1. **Authorized execution:** respect approvals and denials; never reinterpret an unavailable capability or rejection as permission.
2. **Available text:** preserve useful partial or failed-run prose, clearly labeled diagnostic or partial.
3. **Evidence coverage:** count only successful observations. Map each required source/scope to supporting paths and symbols; disclose unresolved gaps. Missing mandatory coverage prevents full acceptance.
4. **Verified completion:** require normal termination, no structured failure, applicable schema validity, and successful durable result capture. Text presence or a generic `completed` status is insufficient.

Treat authorized, side-effect-free exploratory read errors as disclosed limitations—not evidence and not automatic rejection.

## Regression-test plan and limits

Proposed tests, **not executed**:

- Read error followed by sufficient successful evidence: accept with disclosure; missing mandatory evidence: retain only partial output.
- EstaCoda exception boundaries: denial, `unavailable`, uncertain effects, missing contract, and non-worker role.
- EstaCoda valid citations plus abnormal termination or capture failure: reject completion.
- Hermes nonempty text plus explicit failure; iteration exhaustion; interruption; persistent schema invalidity.
- Hermes schema retry exceptions and failure flags, which the inspected retry merger does not propagate.
- Persistence failure before dispatch; stop-gate continuation; whitespace-only and `"(empty)"` summaries.
- One cited file with another required source omitted: distinguish minimum provenance from coverage.

These findings are source-level, not runtime certification or a performance ranking. EstaCoda helper excerpts were partly truncated, with predicates recovered through successful grep. Full authorization, downstream settlement/finalization, and all imported recovery/validation internals remain unverified. Two failed EstaCoda inspection attempts remain disclosed limitations, not supporting evidence.