Both test files passed: 51 tests total. The review found a summary-length defect, strong command-evidence safeguards, and important gaps in edge-case coverage.

## Scope and evidence

Assigned scope: `command-completion-and-task-result-summary`.

Read all four requested files directly using bounded `file_read` pages. No discovery searches or `file_grep` calls were made, and no source or test files were edited.

One evidence limitation: the file tool redacted portions of the command-check key declarations and construction. The surrounding control flow was readable, but the exact complete key expression could not be independently inspected. Imported helper implementations were outside the assigned reading scope.

## Test execution

Actual command, executed once:

```sh
./node_modules/.bin/vitest run --config vitest.node.config.ts src/runtime/command-completion-checks.test.ts src/utils/task-result-summary.test.ts
```

Invocation used `verification: "focused-tests"`, `verificationInputs: ["."]`, `waitMs: 1000`, and no hard timeout.

| Evidence | Observed result |
|---|---|
| Initial receipt | Command still running as `proc_olzqavgf`; started PID `12066` |
| Initial output | Vitest `v4.1.6`; summary tests and first runtime tests already passing |
| Completion collection | `process_logs` on the same process ID; command was not restarted |
| Final status | Exited with code **0**, signal `null` |
| Runtime test file | **47 passed** |
| Summary test file | **4 passed** |
| Total | **51 passed**, **2 files passed** |
| Reported start time | `10:19:08` |
| Reported duration | **3.79s** |
| Timing breakdown | Transform 395ms; setup 34ms; import 462ms; tests 3.26s; environment 0ms |

The per-file counts follow the completed test entries in the tool output; the final Vitest footer explicitly reports the combined 51-test total. These are focused-test results, not a full-suite or coverage-instrumented result.

## Implementation behavior and safeguards

### Command-completion checks

**Evidence matching and authorization boundaries.** Calls are matched to receipts through tool-call IDs; calls without a visible-turn receipt or with a mismatched receipt tool are ignored. A special recovery path retains a denied local command as an obligation only under restrictive conditions: blocked receipt, explicit denial, local supported command tool, no connector or external-effect classification, and settlement proving dispatch never started with no side effects.
Sources: `src/runtime/command-completion-checks.ts:13-40`.

**Mutation-aware freshness.** Completed observations are deduplicated, and observed changes or allowed file writes/patches can invalidate checks. The implementation deliberately does not equate write-capable authorization with an actual observed mutation. Successful file writes/patches with known paths can preserve checks whose declared scopes are unaffected; unknown effects remain broad.
Sources: `src/runtime/command-completion-checks.ts:41-69`, `src/runtime/command-completion-checks.ts:70-80`.

**Narrow file-predicate exception.** A successful literal `test -f path` or `test -s path` can receive a known file dependency when a completed observation shows the regular file unchanged. Such evidence can survive an unrelated materialized file write. Generic shell checks do not receive this automatic dependency narrowing.
Source: `src/runtime/command-completion-checks.ts:70-99`.

**Owned-process and final-exit requirements.** A managed process is tracked from its terminal launch. Polling cannot establish a check from an unowned process, another turn’s process, or an already-collected exit. An intervening relevant mutation marks an outstanding process stale. Passing requires a successful receipt and a successful command result; managed commands must be exited with code zero and no signal. Permission denial, unsuccessful tool results, or possible side effects are not accepted as proof.
Sources: `src/runtime/command-completion-checks.ts:41-46`, `src/runtime/command-completion-checks.ts:76-106`, `src/runtime/command-completion-checks.ts:148-155`.

**Requirement-specific recovery.** Failed receipts are retained and can be classified as recovered when their corresponding check becomes current and passing. Denied local approaches require a later passing local check for the same requirement in the same turn. An unresolved instance of a requirement prevents that requirement from appearing in `passedRequirements`; no checks means `passed` is false.
Source: `src/runtime/command-completion-checks.ts:100-120`.

**Bounded corrective feedback.** Feedback identifies at most eight unresolved labels, includes the total if larger, and explicitly discourages permission bypass, retries of denied actions, and uncertain side-effect reruns. The helper generates guidance; it does not execute retries. Verification labels follow a lowercase, letter-leading, maximum-80-character format. File-output fallback coverage is restricted to the selected turn.
Source: `src/runtime/command-completion-checks.ts:122-165`.

### Task-result summaries

The summary function is extractive: it removes fenced-code regions, normalizes line endings, scans paragraphs, and returns the first meaningful cleaned paragraph. Presentation-only lines are filtered; Markdown links, images, emphasis, inline code, quotes, and list markers receive lightweight cleanup. Leading apparent tail fragments are rejected, and repeated English/Arabic summary labels are removed.
Sources: `src/utils/task-result-summary.ts:1-32`, `src/utils/task-result-summary.ts:34-66`.

Length handling counts Unicode code points, prefers a sufficiently long sentence ending within the prefix, and otherwise truncates near a word boundary and appends an ellipsis.
Source: `src/utils/task-result-summary.ts:68-83`.

## Findings ranked by impact

### 1. Medium — Freshness guarantees depend on complete observations and honest dependency declarations
**Classification: explicit design limitation / risk, not a demonstrated regression.**

Mutation invalidation is based on observed file changes and recorded file-tool operations. The source explicitly acknowledges that unobserved shell changes remain outside check coverage. Likewise, declared verification inputs are consumed as dependency scope; this function cannot prove that a command’s real dependencies were fully declared.

Consequently, a passing check can remain credited despite a relevant change that is not observed, or falls outside an incomplete declared scope. This is significant because freshness is a central completion guarantee, but the implementation is intentionally evidence-bounded rather than a complete filesystem/dependency monitor.
Sources: `src/runtime/command-completion-checks.ts:47-64`, `src/runtime/command-completion-checks.ts:70-88`.

**Recommended follow-up:** document this boundary wherever scoped verification is presented as evidence, and add negative tests demonstrating incomplete scopes and unobserved effects without implying they are detected.

### 2. Low — Ellipsis fallback can exceed `maxChars`
**Classification: proven code-level defect; not exercised by the supplied tests.**

The fallback takes up to `maxChars` code points and then appends `…` without reserving space. If the prefix has no spaces or removable trailing punctuation, the result is `maxChars + 1` code points.

Concrete consequence of the inspected code:

```ts
deriveTaskResultSummary("abcdefghij", 5)
// "abcde…" — 6 code points
```

This violates a strict interpretation of the requested bound. The existing bounding test exercises the complete-sentence branch instead of this fallback.
Sources: `src/utils/task-result-summary.ts:68-83`, `src/utils/task-result-summary.test.ts:21-25`.

**Recommended follow-up:** reserve space for the ellipsis and test tiny limits, uninterrupted tokens, and astral Unicode characters.

### 3. Low — Markdown cleanup can remove meaningful angle-bracket content
**Classification: demonstrated transformation; product correctness risk depends on intended input.**

After preserving recognized HTTP(S)/mailto autolinks, cleanup replaces all remaining `<...>` spans with spaces. For example, a prose placeholder such as `Use <project-name> here.` loses the placeholder. This is lightweight presentation cleanup, not a context-aware Markdown parser.
Source: `src/utils/task-result-summary.ts:43-56`.

**Recommended follow-up:** decide whether placeholders, technical notation, and literal tags should survive, then add focused cases.

### 4. Low — Tail-fragment rejection is sensitive to cleanup order
**Classification: code-derived edge-case risk, not an observed production failure.**

The ellipsis-fragment check runs before removal of leading decorative punctuation and redundant summary labels. Thus `Summary: …fragment` does not undergo another fragment check after its label is removed. The existing test covers only an ellipsis directly at the start.
Sources: `src/utils/task-result-summary.ts:59-65`, `src/utils/task-result-summary.test.ts:27-31`.

**Recommended follow-up:** run fragment validation after normalization as well, if the rejection is intended to apply regardless of a presentation prefix.

## Test-to-behavior coverage

| Behavior | Coverage evidence |
|---|---|
| Missing output, unavailable diagnostic, recovered exploratory failure | `src/runtime/command-completion-checks.test.ts:60-104` |
| Failed requirement survives unrelated success and output repair | `src/runtime/command-completion-checks.test.ts:106-121` |
| Edits invalidate checks; unchanged diagnostics do not | `src/runtime/command-completion-checks.test.ts:123-135` |
| Managed final exit zero versus one; timeout remains unresolved | `src/runtime/command-completion-checks.test.ts:137-154` |
| Cross-turn evidence and stale/collected process exits rejected | `src/runtime/command-completion-checks.test.ts:156-186` |
| Observed shell mutation versus inspections/service start | `src/runtime/command-completion-checks.test.ts:188-222` |
| Denial recovery; ask, unknown dispatch, uncertainty, connectors, external effects, ordering | `src/runtime/command-completion-checks.test.ts:242-289` |
| Missing interpreter/crash/nonzero failure labels; exact-label recheck | `src/runtime/command-completion-checks.test.ts:290-301` |
| Python/terminal interoperability, timeout, nested uncertain effects, invalid labels | `src/runtime/command-completion-checks.test.ts:305-353` |
| Readback progress deduplication and nine-output fallback coverage | `src/runtime/command-completion-checks.test.ts:356-389` |
| Literal file-predicate preservation versus generic-check invalidation | `src/runtime/command-completion-checks.test.ts:392-405` |
| Scoped process freshness, unrelated report patch, broad defaults, unsafe scopes | `src/runtime/command-completion-checks.test.ts:408-468` |
| First meaningful paragraph, Markdown cleanup, sentence bounding, direct tail fragment, summary labels | `src/utils/task-result-summary.test.ts:4-44` |

## Explicit coverage gaps and limitations

### Command-check branches not directly isolated by these tests

- Missing/mismatched receipt tool and missing visible-turn identity.
- Duplicate observation IDs and repeated receipt IDs.
- A foreign process poll without a corresponding launch in the supplied calls.
- Managed zero exit accompanied by a signal.
- Declaration grammar boundaries: empty label, uppercase, leading digit, and 80/81-character boundary.
- Same requirement across differing working directories.
- More than eight unresolved requirements and feedback’s total-count suffix.
- Empty check collections and direct `lastPassedCallId` contract assertions.
- Predicate distinctions such as `-f` versus `-s`, absolute/traversal paths, and failed or non-materialized writes.
- Receipt-side-only connector/external classification, independently of call-side classification.

Relevant implementation: `src/runtime/command-completion-checks.ts:13-120`, `src/runtime/command-completion-checks.ts:125-165`.

### Summary branches not directly exercised

- `undefined`, empty/whitespace-only input, and nonpositive limits.
- Closed and unclosed fences; CRLF handling.
- Table-only, separator-only, quote, list, image, HTML, and autolink inputs.
- Skipping a rejected first paragraph in favor of later meaningful text.
- Ellipsis fallback, no-space tokens, and Unicode truncation.
- Repeated nested labels and alternate label punctuation.
- Nonfinite or fractional numeric limits, for which no explicit runtime validation exists.

Relevant implementation: `src/utils/task-result-summary.ts:7-83`; the four supplied tests are at `src/utils/task-result-summary.test.ts:4-44`.

### What the passing run does not establish

The runtime fixture uses real temporary workspaces, local processes, and Python, so these are partly local integration tests rather than exclusively isolated unit tests. Most fixture calls invoke tools directly; selected cases opt into `ToolExecutor`. Therefore, not every scenario exercises the complete executor path.
Source: `src/runtime/command-completion-checks.test.ts:21-57`.

No coverage report was generated. The successful focused run establishes that the 51 supplied cases passed in this environment; it does not establish exhaustive branch coverage, full-suite compatibility, race freedom, or correctness of every imported helper.
