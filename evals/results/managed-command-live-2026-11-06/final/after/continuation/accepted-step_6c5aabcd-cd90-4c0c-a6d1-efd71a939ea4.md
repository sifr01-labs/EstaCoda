All 51 focused tests passed. Command checks have strong evidence safeguards; summary truncation can exceed its limit. Important edge cases and full integration remain unverified.

## Assessment scope and evidence

This assessment synthesizes the accepted worker result for **`command-completion-and-task-result-summary`**. It is one review scope, not independent corroboration from multiple reviewers.

The worker inspected these four files and reported **no source or test edits**:

- `src/runtime/command-completion-checks.ts`
- `src/runtime/command-completion-checks.test.ts`
- `src/utils/task-result-summary.ts`
- `src/utils/task-result-summary.test.ts`

The findings below distinguish static source observations from executed tests. Examples inferred from source are not presented as additional executed test cases.

**Inspection limits:** portions of the command-check key declarations and construction were redacted by the file-reading tool. The surrounding control flow was visible, but the complete key expression was not independently inspectable. Imported helper implementations were outside the worker’s assigned scope.

## Test execution and completion evidence

The worker reported executing this command **once**:

```sh
./node_modules/.bin/vitest run --config vitest.node.config.ts src/runtime/command-completion-checks.test.ts src/utils/task-result-summary.test.ts
```

| Item | Observed worker receipt |
|---|---|
| Runner | Vitest `v4.1.6` |
| Initial execution | Running as `proc_olzqavgf`, PID `12066` |
| Completion collection | `process_logs` against that same process; **no restart** |
| Final exit code | **0** |
| Final signal | `null` |
| Command-check tests | **47 passed** |
| Summary tests | **4 passed** |
| Combined result | **51 tests passed; 2 files passed** |
| Reported duration | **3.79 seconds** |
| Timing breakdown | Transform 395 ms; setup 34 ms; import 462 ms; tests 3.26 s; environment 0 ms |

The final Vitest footer explicitly reported the combined 51-test total; the per-file counts came from completed test entries. The invocation used focused-test verification and no hard timeout.

This establishes a successful **focused run**, not a full-suite result or an instrumented coverage measurement. The same-process completion claim is supported by the worker’s launch and follow-up receipts; this synthesis did not rerun the command.

## Prioritized findings

### 1. Confirmed code-level defect: summary truncation can exceed `maxChars`

**Severity: Low. Evidence: static source inspection; not covered by the executed tests.**

The fallback truncation branch takes up to `maxChars` Unicode code points and then appends an ellipsis without reserving room for it. If no intervening word-boundary or punctuation trimming shortens the prefix, the output has `maxChars + 1` code points.

The worker derived this example from the implementation:

```ts
deriveTaskResultSummary("abcdefghij", 5)
// "abcde…" — 6 code points
```

This violates a strict maximum-length contract. The existing length test exercises the complete-sentence branch, so its passing result does not validate this fallback.
**Sources:** `src/utils/task-result-summary.ts:68-83`; `src/utils/task-result-summary.test.ts:21-25`.

**Recommended follow-up:** reserve room for the ellipsis and add cases for tiny limits, uninterrupted tokens, and astral Unicode characters. No fix was made during this review.

### 2. Important design boundary: command freshness is only as complete as its observations and declared dependencies

**Impact: Medium. Evidence: explicit implementation limitation, not a demonstrated regression.**

Invalidation relies on recorded observations and file-tool operations. The implementation acknowledges that unobserved shell changes are outside its coverage. It also consumes declared verification inputs as dependency scopes; it does not prove that those declarations include every dependency a command actually used.

A check can therefore remain credited after a relevant change that was either unobserved or excluded by an incomplete scope. This limits the strength of any claim that a passing check necessarily reflects all current repository state. It does **not** establish that the tested invalidation mechanisms are broken.
**Sources:** `src/runtime/command-completion-checks.ts:47-64`, `src/runtime/command-completion-checks.ts:70-88`.

**Recommended follow-up:** document this boundary alongside scoped-verification guarantees, and add negative tests that explicitly demonstrate the limits of incomplete scopes and unobserved effects.

### 3. Conditional correctness risk: cleanup removes meaningful angle-bracket content

**Severity: Low. Evidence: static transformation; impact depends on intended input.**

After preserving recognized HTTP(S) and mailto autolinks, cleanup removes remaining `<...>` spans. A placeholder such as `Use <project-name> here.` consequently loses meaningful content.

This is consistent with lightweight presentation cleanup, but it is not context-aware Markdown handling. Whether it is a defect depends on whether technical placeholders and literal angle-bracket notation must survive.
**Source:** `src/utils/task-result-summary.ts:43-56`.

**Recommended follow-up:** define the expected treatment of placeholders, literal tags, and technical notation, then test those cases.

### 4. Edge-case risk: tail-fragment rejection precedes label cleanup

**Severity: Low. Evidence: static control-flow observation, not an observed production failure.**

The leading-ellipsis check runs before decorative prefixes and summary labels are removed. Consequently, `Summary: …fragment` is not rechecked after the label is stripped. The existing test covers an ellipsis directly at the beginning, not this prefixed form.
**Sources:** `src/utils/task-result-summary.ts:59-65`; `src/utils/task-result-summary.test.ts:27-31`.

**Recommended follow-up:** if fragment rejection should apply regardless of presentation prefixes, validate again after normalization.

## Implementation and safeguards

### Command-completion checks

The implementation is an evidence-accounting mechanism: it determines whether command receipts establish current, requirement-specific completion. It does not simply accept reassuring output text.

- **Receipt and turn matching.** Calls are associated with receipts through tool-call IDs. Missing visible-turn receipts and mismatched receipt tools are ignored. A denied local command is retained as an obligation only under restrictive conditions: explicit denial, blocked receipt, supported local command tool, no connector/external-effect classification, and settlement showing dispatch never started with no side effects.
  **Source:** `src/runtime/command-completion-checks.ts:13-40`.

- **Mutation-aware freshness.** Completed observations are deduplicated. Observed changes and relevant allowed file writes or patches can invalidate earlier checks. Write-capable authorization alone is not treated as proof that a mutation occurred. Known-path writes can preserve checks whose declared scopes are unaffected; unknown effects remain broad.
  **Sources:** `src/runtime/command-completion-checks.ts:41-80`.

- **Narrow file-predicate preservation.** Successful literal `test -f path` and `test -s path` checks can acquire a known file dependency when a completed observation establishes an unchanged regular file. This allows survival across unrelated materialized writes. Generic shell commands do not automatically receive that narrowing.
  **Source:** `src/runtime/command-completion-checks.ts:70-99`.

- **Owned-process and final-exit requirements.** Managed processes are tracked from launch. Polling an unowned process, a process from another turn, or an already-collected exit cannot establish a fresh check. Relevant intervening mutations make an outstanding process stale. Passing requires both a successful receipt and successful command result; managed commands must finish with exit code zero and no signal.
  **Sources:** `src/runtime/command-completion-checks.ts:41-46`, `src/runtime/command-completion-checks.ts:76-106`, `src/runtime/command-completion-checks.ts:148-155`.

- **Requirement-specific recovery.** Failures remain recorded until the corresponding check becomes current and passing. Recovery from a denied local approach requires a later passing local check for the same requirement in the same turn. An unresolved instance blocks that requirement from `passedRequirements`; an empty collection does not count as passing.
  **Source:** `src/runtime/command-completion-checks.ts:100-120`.

- **Bounded, safety-conscious feedback.** Corrective guidance lists at most eight unresolved labels, with a total when larger. It discourages permission bypass, denied-action retries, and reruns with uncertain side effects. The helper produces guidance rather than executing retries. Verification labels are lowercase, letter-leading, and limited to 80 characters; file-output fallback evidence is turn-scoped.
  **Source:** `src/runtime/command-completion-checks.ts:122-165`.

These are substantial safeguards against incorrectly crediting unrelated, stale, denied, or incomplete command evidence. Their guarantees remain bounded by the observation and dependency limitations described above.

### Task-result summaries

The summary implementation is **extractive**, not generative. It removes fenced-code regions, normalizes line endings, scans paragraphs, and selects the first meaningful cleaned paragraph. Presentation-only material is filtered, and Markdown constructs receive lightweight cleanup. It also strips repeated English/Arabic summary labels and rejects some apparent leading tail fragments.
**Sources:** `src/utils/task-result-summary.ts:1-32`, `src/utils/task-result-summary.ts:34-66`.

Length handling counts Unicode code points, prefers a sufficiently long complete sentence within the prefix, and otherwise truncates near a word boundary with an appended ellipsis. That fallback is where the confirmed length defect occurs.
**Source:** `src/utils/task-result-summary.ts:68-83`.

## What the tests actually cover

### Command-check evidence: 47 passing cases

The tests cover meaningful success, failure, recovery, and freshness scenarios:

| Tested behavior | Source |
|---|---|
| Missing output, unavailable diagnostics, exploratory-failure recovery | `src/runtime/command-completion-checks.test.ts:60-104` |
| Failed requirements surviving unrelated success and output repair | `src/runtime/command-completion-checks.test.ts:106-121` |
| Edit invalidation versus unchanged diagnostics | `src/runtime/command-completion-checks.test.ts:123-135` |
| Managed zero/nonzero exit and unresolved timeout | `src/runtime/command-completion-checks.test.ts:137-154` |
| Cross-turn, stale, and already-collected process evidence | `src/runtime/command-completion-checks.test.ts:156-186` |
| Observed shell mutation versus inspection/service start | `src/runtime/command-completion-checks.test.ts:188-222` |
| Denial recovery, uncertain dispatch/effects, connectors, external effects, ordering | `src/runtime/command-completion-checks.test.ts:242-289` |
| Failure labeling, exact-label rechecks, Python/terminal interoperability, invalid labels | `src/runtime/command-completion-checks.test.ts:290-353` |
| Readback deduplication and multi-output fallback | `src/runtime/command-completion-checks.test.ts:356-389` |
| Literal file predicates versus generic-check invalidation | `src/runtime/command-completion-checks.test.ts:392-405` |
| Scoped freshness, unrelated patches, broad defaults, unsafe scopes | `src/runtime/command-completion-checks.test.ts:408-468` |

These are **not exclusively isolated unit tests**. The runtime fixture uses real temporary workspaces, local processes, and Python, providing some local integration evidence. However, most fixture calls invoke tools directly; only selected cases use `ToolExecutor`. Passing these tests therefore does not establish complete executor-path behavior for every scenario.
**Source:** `src/runtime/command-completion-checks.test.ts:21-57`.

### Summary unit-test evidence: 4 passing cases

The summary tests exercise first-meaningful-paragraph selection, representative Markdown cleanup, sentence-based bounding, direct leading-tail-fragment rejection, and summary-label removal. They do not exercise the fallback length defect.
**Source:** `src/utils/task-result-summary.test.ts:4-44`.

## Explicit missing coverage

### Command-check branches not directly isolated

The worker identified these gaps:

- Missing or mismatched receipt tools and missing visible-turn identity.
- Duplicate observation IDs and repeated receipt IDs.
- Foreign-process polling without a corresponding launch.
- A managed zero exit accompanied by a signal.
- Label grammar boundaries: empty, uppercase, digit-leading, and 80/81-character cases.
- The same requirement across different working directories.
- More than eight unresolved requirements and the feedback total-count suffix.
- Empty check collections and direct assertions of the `lastPassedCallId` contract.
- Predicate distinctions, absolute/traversal paths, and failed or non-materialized writes.
- Receipt-side-only connector/external classification independently of call-side classification.

**Relevant source:** `src/runtime/command-completion-checks.ts:13-120`, `src/runtime/command-completion-checks.ts:125-165`.

### Summary branches not directly exercised

Missing focused cases include:

- Undefined, empty, whitespace-only inputs and nonpositive limits.
- Closed/unclosed code fences and CRLF normalization.
- Table-only, separator-only, quote, list, image, HTML, and autolink inputs.
- Skipping a rejected first paragraph for a later meaningful paragraph.
- Ellipsis fallback, uninterrupted tokens, and Unicode truncation.
- Repeated nested labels and alternate label punctuation.
- Nonfinite or fractional numeric limits, for which no explicit runtime validation was identified.

**Relevant source:** `src/utils/task-result-summary.ts:7-83`; existing tests at `src/utils/task-result-summary.test.ts:4-44`.

### Integration and broader validation not established

No coverage report or full-suite result was produced. The review does not establish exhaustive branch coverage, complete end-to-end executor integration, race freedom, or correctness of imported helpers. The redacted key construction also leaves an inspection gap around exact check identity.

## Bottom line

The strongest confirmed defect is the summary fallback’s off-by-one length behavior. The command-check implementation has substantial safeguards, supported by a successful focused run, but freshness must be described as **observation- and declaration-bounded**, not an absolute guarantee about repository state.

The next priorities are to fix and directly test the summary bound, make the freshness boundary explicit, and expand edge-case and complete-executor-path coverage. No source or test changes were made.
