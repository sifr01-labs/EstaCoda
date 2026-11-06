Both test files passed: 51 tests across 2 files. The review found strong completion safeguards, a summary-length defect, and several untested edge cases.

## Evidence and scope

Reviewed directly through the supplied file tools:

- `src/runtime/command-completion-checks.ts`
- `src/runtime/command-completion-checks.test.ts`
- `src/utils/task-result-summary.ts`
- `src/utils/task-result-summary.test.ts`
- `package.json`
- `vitest.node.config.ts`

No discovery search, source/test edits, dependency installation, or test-command restart was performed. The supplied execution receipts confirm these reads and the completed test run.

**Evidence limits:** imported helper implementations were not reviewed. Some identity-key expressions were redacted in file-tool output, so their complete construction could not be verified. Findings below do not reconstruct that missing text. Potential failure examples are static analysis, not additional executed tests.

## Test execution record

Executed **once**, using local Vitest:

```sh
./node_modules/.bin/vitest run --config vitest.node.config.ts src/runtime/command-completion-checks.test.ts src/utils/task-result-summary.test.ts
```

| Setting/result | Recorded value |
|---|---|
| Verification label | `command-completion-and-summary-tests` |
| Verification inputs | `["."]` |
| Timeout argument supplied | `timeoutMs: null` |
| Separate observation/yield control | Not available in the supplied schema |
| Approximately one-second observation | Could not be configured independently; limitation disclosed before execution |
| Process identifier printed | `12505` |
| Vitest version reported | **4.1.6** |
| Final exit code | **0**, signal **null** |
| Test files | **2 passed / 2** |
| Tests | **51 passed / 51** |
| Per-file test counts | Completion checks: **47**; summary: **4** |
| Reported start | `10:19:58` |
| Reported duration | **3.69 s** |
| Timing breakdown | Transform 355 ms; setup 31 ms; import 411 ms; tests 3.23 s; environment 0 ms |

The tool schema treats `timeoutMs` as a hard execution limit. Passing `null` selected default behavior rather than a one-second kill limit; technically, the argument was supplied as `null` rather than omitted.

The terminal returned the final exit in the same response that printed the process identifier. No outstanding process required `process.logs`, and the command was never restarted.

The configuration specifies Node execution, a setup file, and verbose reporting (`vitest.node.config.ts:3–10`). These are correctness-test receipts, **not comparative performance evidence**.

## 1. Command-completion checks

### Design strengths

**Passing requires execution evidence, not prose or successful polling.**
Calls must have a matching tool receipt and visible turn. Passing then requires a success receipt, non-stale process state, and `commandSucceeded`. For a managed process, that helper requires an exited process with exit code zero and no signal; it also rejects disallowed calls, unsuccessful results, and possible side effects.

Evidence: `src/runtime/command-completion-checks.ts:27–29`, `src/runtime/command-completion-checks.ts:82–85`, `src/runtime/command-completion-checks.ts:153–159`.

The passing tests explicitly distinguish successful log retrieval from successful validation for both zero and nonzero command exits.

Test evidence: `src/runtime/command-completion-checks.test.ts:133–145`.

**Unrelated success does not erase requirement-specific failure.**
Final aggregation retains unresolved requirements and removes those labels from `passedRequirements`. Feedback names outstanding labels and instructs reuse of the exact verification label rather than substituting readback or another check.

Evidence: `src/runtime/command-completion-checks.ts:106–125`.

Passing tests cover output repair remaining insufficient until the same requirement passes, a different command proving that same requirement, and unrelated labels failing to recover exits 127, 139, and 1.

Test evidence: `src/runtime/command-completion-checks.test.ts:103–117`, `src/runtime/command-completion-checks.test.ts:187–195`, `src/runtime/command-completion-checks.test.ts:288–297`.

**Freshness tracking distinguishes observed edits from write authority.**
Completed observations and file-write metadata drive invalidation. Successful file writes/patches can supply a concrete changed path; unknown effects remain broad. Only narrowly recognized, observed `test -f`/`test -s` predicates receive the independent-write exception.

Evidence: `src/runtime/command-completion-checks.ts:47–77`, `src/runtime/command-completion-checks.ts:89–95`.

Passing tests cover output edits, observed shell mutations, inspections/service starts, and preserving a simple predicate across an unrelated write without narrowing a compound predicate.

Test evidence: `src/runtime/command-completion-checks.test.ts:119–131`, `src/runtime/command-completion-checks.test.ts:197–219`, `src/runtime/command-completion-checks.test.ts:392–405`.

**Managed exits cannot ordinarily be replayed into fresh validation.**
Processes track their owning turn, staleness, collection, and inputs. Unowned, different-turn, or already-collected process polls are ignored. Mutations can stale running checks.

Evidence: `src/runtime/command-completion-checks.ts:41–46`, `src/runtime/command-completion-checks.ts:75–84`, `src/runtime/command-completion-checks.ts:104`.

Both edit-order test cases passed: editing before collecting the exit and editing after collecting it. Repeated polling remained insufficient; a fresh replacement check restored completion.

Test evidence: `src/runtime/command-completion-checks.test.ts:167–185`.

**Denied-action recovery preserves authority boundaries.**
Recovery is restricted to blocked local checks denied before dispatch with no side effects. It requires a later passing local check of the same requirement in the same turn that remains current.

Evidence: `src/runtime/command-completion-checks.ts:30–39`, `src/runtime/command-completion-checks.ts:97–111`.

Passing tests reject recovery across ask, unknown-dispatch, uncertain-effect, connector, external-side-effect, wrong-turn, wrong-label, reversed-order, and stale-output cases.

Test evidence: `src/runtime/command-completion-checks.test.ts:259–287`.

**Declared input scopes support independent report edits.**
Scope metadata participates in invalidation for both completed checks and managed processes.

Evidence: `src/runtime/command-completion-checks.ts:43–45`, `src/runtime/command-completion-checks.ts:62–77`, `src/runtime/command-completion-checks.ts:86–88`.

Passing tests demonstrate preserving source checks across report edits, invalidating affected source checks, conservative omitted/whole-workspace scopes, and rejection of six unsafe or ambiguous scope forms.

Test evidence: `src/runtime/command-completion-checks.test.ts:409–457`.

### Potential bugs and limitations

**Medium, conditional: overlapping attempts lack explicit supersession semantics.**
Eligible observations overwrite the boolean associated with a check identity. Process state tracks ownership/staleness/collection, but not an attempt generation or supersession relationship.

Evidence: `src/runtime/command-completion-checks.ts:26`, `src/runtime/command-completion-checks.ts:41–46`, `src/runtime/command-completion-checks.ts:82–88`.

If two attempts share an identity, collecting an older attempt after a newer one can replace the newer result’s state. Whether that is undesirable depends on the intended policy for concurrent replacement checks. This is **not a reproduced failure**; the existing managed-process tests cover stale/repeated collection rather than concurrent same-requirement attempts.

Test boundary: `src/runtime/command-completion-checks.test.ts:133–185`.

**Intentional coverage limit: unobserved shell mutations are not inferred.**
The implementation explicitly acknowledges this limitation and avoids equating write authority with an observed edit. Passing evidence therefore establishes freshness relative to recorded observations and declared scopes—not independently proven dependency completeness.

Evidence: `src/runtime/command-completion-checks.ts:47–57`.

**Low, conditional: fallback coverage depends on receipt ordering.**
Without `originTurnId`, `hasFileOutputCoverage` chooses the last receipt’s visible turn. This requires the caller’s receipt ordering to identify the intended turn.

Evidence: `src/runtime/command-completion-checks.ts:163–170`.

The nine-output integration test checks cross-turn rejection but does not directly exercise unordered receipts or both explicit/fallback turn-selection paths.

Test evidence: `src/runtime/command-completion-checks.test.ts:368–390`.

### Explicitly missing coverage

The reviewed test file has no explicit cases for:

- Concurrent same-requirement attempts with out-of-order exits.
- Duplicate/mismatched receipts or missing visible-turn IDs.
- `lastPassedCallId` selection.
- Feedback truncation beyond eight unresolved labels.
- Label-length boundaries at 80/81 characters.
- Direct explicit-versus-fallback turn selection in `hasFileOutputCoverage`.
- Quoted, absolute, or traversal paths disqualifying the simple-predicate optimization.

Relevant branches: `src/runtime/command-completion-checks.ts:16–29`, `src/runtime/command-completion-checks.ts:89–125`, `src/runtime/command-completion-checks.ts:128–170`.

These are gaps in the **assigned test file**, not claims about all repository tests.

## 2. Task-result summary

### Design strengths and tested behavior

**Small, extractive pipeline.**
The function removes backtick-fenced code, splits paragraphs, filters presentation-only lines, cleans Markdown, and selects the first meaningful candidate. Cleanup and bounding are separated into small functions.

Evidence: `src/utils/task-result-summary.ts:3–65`.

**Sentence-aware and code-point-aware bounding.**
Initial measurement and slicing use spread code points. Bounding prefers a sufficiently long complete sentence, then falls back to a word boundary and ellipsis.

Evidence: `src/utils/task-result-summary.ts:67–82`.

The four passing tests establish first-meaningful-paragraph selection, basic Markdown/link removal, complete-sentence truncation, leading-fragment rejection, and English/Arabic summary-label cleanup.

Test evidence: `src/utils/task-result-summary.test.ts:5–44`.

### Defect and qualified risks

**Low severity, high confidence: ellipsis fallback can exceed `maxChars`.**
The implementation takes up to `maxChars` code points and then appends an ellipsis without reserving space.

Evidence: `src/utils/task-result-summary.ts:70–82`.

Static evaluation gives:

```ts
deriveTaskResultSummary("abcdefghij", 5)
// "abcde…" — six code points
```

This violates a strict character cap. The existing bounding test exercises complete-sentence truncation, not this fallback. The example above was not separately executed.

Test evidence: `src/utils/task-result-summary.test.ts:21–25`.

**Low, conditional semantic risk: literal technical notation is stripped.**
After removing inline-code delimiters, cleanup globally removes remaining asterisks and tildes. Literal examples such as `~10 ms`, `*.ts`, and `a*b` lose potentially meaningful characters; backticks do not protect them because they are removed earlier.

Evidence: `src/utils/task-result-summary.ts:52–56`.

**Low, conditional: non-HTML angle-bracket content can disappear.**
The broad `<[^>]+>` replacement removes bracketed spans not already handled as supported autolinks. Literal placeholders such as `<value>` can therefore disappear.

Evidence: `src/utils/task-result-summary.ts:50–51`.

**Low, conditional: tilde-fenced code is not excluded as code.**
Fence-removal expressions recognize triple backticks, not tilde fences. Tilde delimiter lines may be filtered as presentation separators while their body remains eligible for summary selection. This matters if tilde-fenced Markdown is accepted input.

Evidence: `src/utils/task-result-summary.ts:13–15`, `src/utils/task-result-summary.ts:21–27`, `src/utils/task-result-summary.ts:34–40`.

The technical-notation, placeholder, and fence cases are absent from the four reviewed tests.

Test evidence: `src/utils/task-result-summary.test.ts:5–44`.

### Explicitly missing coverage

The reviewed summary tests do not explicitly cover:

- Undefined, empty, whitespace-only, heading-only, or table-only input.
- Zero, negative, fractional, `NaN`, or infinite limits.
- Exact-boundary lengths, long tokens, or the ellipsis path’s strict length bound.
- Emoji, combining characters, or grapheme boundaries.
- Closed/unclosed backtick fences or tilde fences.
- HTML versus literal placeholders.
- Literal operators, globs, or approximate-number notation.
- Nested-parenthesis links or reference-style links.
- A rejected first fragment followed by a valid later paragraph.

Implementation branches: `src/utils/task-result-summary.ts:11–29`, `src/utils/task-result-summary.ts:34–82`. Complete reviewed test file: `src/utils/task-result-summary.test.ts:1–44`.

## Overall assessment

The completion-check implementation has broad passing integration coverage for final exits, requirement-specific recovery, stale-evidence handling, authority boundaries, and declared scopes. Concurrent-attempt precedence remains a qualified design question.

The summary helper is readable but more lightly tested. Its clearest actionable defect is exceeding the requested limit on the ellipsis path; technical-notation preservation and alternate code fences are additional compatibility risks.

**The requested single test run completed successfully. No implementation changes were made.**
