EstaCoda can accept research after qualifying local read errors, but acceptance still requires authorization, successful evidence, and normal completion—not merely report text.

## Scope and source identity

This worker investigated **EstaCoda only**. Hermes comparison remains the other worker’s scope.

`MANIFEST.json` identifies the EstaCoda baseline as `c7d656c614d9acf5b9649148fa2d6d6e8c5b3c4b` and the supplied executor snapshot by SHA-256 `ceaa55c1af806671d24d4556047f70a285db7db44d723b44c6b2ee5e4464331f`. It does **not** provide an “after” commit revision. The recovered Git log identified fixture commit `61347762fb4ded99d0a48ffb366ef678bc8c3314`, not an upstream EstaCoda revision. These identities are manifest declarations; I did not independently recompute hashes. [ `MANIFEST.json` ]

## Requested probes and recovery

Both seeded failures were reproduced once, before source investigation:

- `terminal.inspect`, `["git","log","-1"]`: rejected with `git log argument is not allowed: -1`.
- `file.grep`, requested pattern/path and empty `max_filesize`: failed because the size must be a nonempty digit sequence with an optional suffix.

Recovery used `git log -n 1` and successful `file.grep` with `max_filesize: "2M"`, followed by bounded source reads. Neither rejected formulation was repeated. These outcomes establish only the requested input-regression observations—not application behavior, permission bypass, or failed research coverage.

## Implementation findings

### 1. Local read failure is narrowly classified, not globally ignored

`hasUnrecoveredToolFailure` considers unsuccessful tool results and empty passage lookups, then excludes recognized limitations or recoveries.

The important local exception, `isLocalResearchReadLimitation`, requires **all** of:

- worker role;
- repository evidence required;
- a research request contract;
- execution decision `allow`;
- risk class `read-only-local`;
- one of `terminal.inspect`, `file.read`, `file.grep`, `file.search`, or `file.glob`;
- settlement absent or side-effect state `none`;
- result metadata reason other than `unavailable`.

Consequently, a qualifying local read error need not be repaired by an identical retry to stop blocking acceptance. This does not itself prove the requested source was inspected. The exact classification predicates were visible through successful grep; the targeted `file.read` excerpts around these helpers were truncated. [ `estacoda/src/tasks/agent-step-executor.ts:925–947`, symbols `hasUnrecoveredToolFailure`, `isLocalResearchReadLimitation` ]

### 2. Completion feedback and final settlement share validation

`researchCompletionFailure` first calls `groundResearchResult`, then checks unrecovered tool failures, then calls `researchEvidenceFailure`. The worker loop receives this function as its completion validator, and settlement invokes it again before capturing successful results. Thus the source implements both an opportunity to correct evidence during execution and a final acceptance check. [ `estacoda/src/tasks/agent-step-executor.ts:318–342, 446–449, 711–721` ]

### 3. Repository evidence is a minimum provenance gate—not exhaustive coverage

For repository-required research, `researchEvidenceFailure` filters for allowed, successful executions. It requires:

1. successful discovery through `file.search`, `file.grep`, or `file.glob`;
2. at least one successful `file.read` yielding an observed path;
3. a workspace reference in the report matching at least one observed path.

This does **not** mechanically require every assigned symbol, source, or claim to have supporting observations. Therefore, passing this gate must not be described as verified exhaustive research. [ `estacoda/src/tasks/agent-step-executor.ts:724–764`, `researchEvidenceFailure` ]

For this repository-only worker, the stronger live-source table machinery does not automatically apply: `requiresSourceTable` requires live-source research on the step or a dependency, and `groundResearchResult` otherwise returns the input text immediately. [ `estacoda/src/tasks/research-result-evidence.ts:14–22`, `requiresSourceTable`, `groundResearchResult` ]

### 4. Authorization, text availability, and success remain distinct

Settlement handles approval requests, setup approvals, structured security blocks, spending denials, and provider failures before accepting research. Unrecovered tool failures produce a failed outcome. Non-normal termination or completion-validation failure also produces failure, potentially with diagnostic text. Only after evidence validation and successful `captureResults` does the executor return `outcome: "succeeded"`. [ `estacoda/src/tasks/agent-step-executor.ts:377–474` ]

`safeDiagnosticOutput` can preserve nonempty text from a failed attempt only when every recorded execution has a read-only-local or read-only-network risk class. Its summary explicitly marks that text incomplete and **not accepted as the Step result**. Provider-accounting recovery similarly returns failure rather than promoting diagnostic prose into accepted completion. [ `estacoda/src/tasks/agent-step-executor.ts:476–495, 906–921` ]

### 5. Accepted output retains a limitation notice

`researchReadLimitations` appends the number of qualifying failed local reads and their tool names, without copying failed arguments, paths, or error bodies. Its notice says failures are not evidence and acceptance does not establish that every requested source was inspected. Settlement appends this notice before result capture. [ `estacoda/src/tasks/agent-step-executor.ts:450–458, 942–947` ]

## Recommended acceptance policy and regression plan

**Policy:** Treat authorized, side-effect-free exploratory read errors as disclosed limitations, not automatic rejection. Independently require successful source evidence, explicit unresolved coverage gaps, normal completion, and successful result capture. Preserve failed-attempt prose as diagnostic—not accepted evidence. Never reinterpret denial or unavailable capability as permission to retry differently.

Proposed tests, **not executed**:

- Both seeded argument errors followed by supported reads: allow acceptance when other gates pass; retain limitation notice.
- Same errors without successful discovery/read/citation: fail repository evidence.
- Allowed local read with `reason: unavailable`, uncertain side effects, missing research contract, or non-worker role: do not apply the local exception.
- Denied/approval-required execution: never convert into an accepted limitation.
- Good citations plus abnormal termination or failed capture: fail completion.
- Read-only diagnostic prose after provider/accounting failure: preserve as diagnostic only.
- A report citing one observed file while omitting another required source: demonstrate the minimum provenance gate’s coverage limitation and require explicit gap reporting.

## Remaining uncertainty

This was source inspection, not execution of application tests. Some helper `file.read` results were truncated; successful grep supplied their exact predicates. I did not inspect all recovery helpers, downstream durable-store settlement, independently verify hashes, or assess Hermes. Accordingly, these findings establish executor-level acceptance logic—not end-to-end verified task completion.

Research read limitations: 2 local read attempt(s) failed (file.grep, terminal.inspect). These attempts are not evidence and remain recorded in the worker history. Acceptance of this report does not establish that every requested source was inspected. Use only successful observations and preserve any unresolved coverage gaps in synthesis.