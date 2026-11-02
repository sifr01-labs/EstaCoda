EstaCoda can accept repository research after ordinary local read failures, but authorization, successful evidence, and completion remain separate gates.

## Scope and source identity

This is the **EstaCoda-source worker result**, not the cross-codebase synthesis. I inspected the relevant executor sections and a bounded grounding-helper excerpt; I did not inspect Hermes or execute upstream tests.

`MANIFEST.json` identifies EstaCoda’s `before` revision as `c7d656c614d9acf5b9649148fa2d6d6e8c5b3c4b`. It identifies the supplied executor content by SHA-256 `ceaa55c1af806671d24d4556047f70a285db7db44d723b44c6b2ee5e4464331f` in both `afterSourceHashes` and `inputHashes`. It does **not** provide an after-source commit identifier. The successful `git log -n 1` returned fixture commit `04e056cc261c2a267d7e50b7fe8a7a40b3af26e8`; that is not an upstream EstaCoda revision. These are manifest-reported identities, not independently recomputed hashes. [ `MANIFEST.json` ]

## Probe execution and recovery

Before investigating source, I submitted each requested invalid formulation once:

- `terminal.inspect`, `["git","log","-1"]`: rejected with `git log argument is not allowed: -1`.
- `file.grep`, requested pattern/path and `max_filesize: ""`: rejected because the empty size is invalid.

Recovery used `git log -n 1`, successful discovery through `file.glob`, and successful `file.grep` with `max_filesize: "2M"`, followed by bounded `file.read` observations. Neither rejected formulation was repeated. These probes demonstrate input failures and recovery in this investigation; they are **not evidence of implementation behavior or passing regression tests**.

## Implementation findings

### 1. Ordinary local research failures need not poison the attempt

`hasUnrecoveredToolFailure` examines failed tool results and empty passage lookups. An error remains unrecovered only when none of its listed exceptions applies, including `isLocalResearchReadLimitation`, recovered reads, recovered passage lookups, recovered delivery validation, or alternative research reads. [ `estacoda/src/tasks/agent-step-executor.ts:925–927`, `hasUnrecoveredToolFailure` ]

The new local limitation predicate is deliberately scoped. It requires:

- a worker with repository evidence required;
- a research requirement in the request contract;
- tool decision `allow` and risk class `read-only-local`;
- one of `terminal.inspect`, `file.read`, `file.grep`, `file.search`, or `file.glob`;
- absent settlement or settlement with `sideEffectState === "none"`;
- a result reason other than `"unavailable"`.

Crucially, this predicate does **not** require an identical successful retry. That conclusion follows from the predicate’s conditions and its direct exclusion in `hasUnrecoveredToolFailure`, rather than merely its explanatory comment. [ `estacoda/src/tasks/agent-step-executor.ts:933–939`, `isLocalResearchReadLimitation` ]

This is not permission to retry denied actions: a non-`allow` decision does not qualify.

### 2. Failed reads become limitations, not evidence

`researchReadLimitations` counts failed results qualifying under that predicate, collects sorted unique tool names, and appends a durable warning. The warning explicitly says failed attempts are not evidence and accepting the report does not establish that every requested source was inspected. Its rendered text includes counts and tool names, not failed arguments, paths, or error bodies. [ `estacoda/src/tasks/agent-step-executor.ts:942–947`, `researchReadLimitations` ]

### 3. Evidence validation remains separate

`researchCompletionFailure` first invokes `groundResearchResult`, then checks unrecovered failures, then invokes `researchEvidenceFailure`. The same function is supplied as completion feedback and called again during executor settlement. [ `estacoda/src/tasks/agent-step-executor.ts:341,446,711–722` ]

For repository evidence, `researchEvidenceFailure` considers only executions with decision `allow` and result `ok === true`. It requires successful discovery, at least one successful `file.read` yielding an observed workspace-relative path, and a textual reference to at least one observed path. Failed probes cannot satisfy those requirements. [ `estacoda/src/tasks/agent-step-executor.ts:724–765`, `researchEvidenceFailure` ]

**Important boundary:** this is a minimum evidence-presence check, not verification that every requested symbol was read or every claim follows from cited lines. The local error exemption also does not distinguish optional exploratory reads from specifically requested repository reads. Therefore an unresolved required-source gap must remain explicit even if the report passes these structural checks.

`groundResearchResult` has additional source-table and citation checks when enabled, but its opening branch returns the original text when `requiresSourceTable` is false. I did not trace that enabling predicate sufficiently to claim these URL-oriented checks apply to this repository-only assignment. [ `estacoda/src/tasks/research-result-evidence.ts:20–53`, `groundResearchResult` ]

### 4. Available text is not accepted completion

The settlement path separately handles approval requests, structured security blocks, spending denials, provider failures, and unrecovered tool failures. It then checks delivery evidence where applicable, abnormal termination or completion-validation failure, and research completion validation. Only afterward does it ground text, append limitations, capture results, and return `outcome: "succeeded"`. Capture failure still returns failure. [ `estacoda/src/tasks/agent-step-executor.ts:370–473` ]

Failure branches may preserve diagnostic output. `safeDiagnosticOutput` labels it incomplete and not accepted as the Step result, and suppresses it when any recorded tool risk is outside the two read-only classes. The accounting-error catch likewise returns failure even when it preserves redacted diagnostic text. [ `estacoda/src/tasks/agent-step-executor.ts:475–495,910–921` ]

## Recommended acceptance policy and regression plan

**Recommendation:** retain four independent states: execution authorization, report availability, evidence coverage, and verified completion. Permit authorized, side-effect-free local read errors as recorded limitations; never count them as evidence. Accept only a normally completed, validated report, explicitly carrying unresolved coverage gaps.

Proposed tests—not executed:

1. Both seeded input failures followed by successful discovery/read/citation: accept and append limitations.
2. Same failures without successful discovery or `file.read`: reject for repository evidence.
3. Denied, unavailable, or uncertain-side-effect reads: do not apply the local limitation exemption.
4. Valid evidence plus abnormal termination or completion-validation failure: preserve only eligible diagnostics; do not succeed.
5. Successful evidence for one file but a missing requested source: ensure the unresolved coverage gap survives acceptance and synthesis.
6. Capture failure after valid research: remain failed.

**Unverified:** upstream tests, end-to-end persisted settlement, hash recomputation, full coverage of recovery helpers, and semantic correctness of every accepted claim. Some late `file.read` excerpts were truncated; the local-limitation predicates above were recovered through successful line-numbered `file.grep`, not invented from missing output.