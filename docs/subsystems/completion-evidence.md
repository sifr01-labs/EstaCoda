# Completion evidence

Local command evidence is collected by the runtime, not supplied by model prose.
`terminal.run` and `execute_code` may declare a `verification` requirement label.
An alternative implementation must use the same label and execution directory;
a successful unrelated check cannot erase an earlier required failure. Labels
add obligations and never grant execution authority.

A completed Python process explicitly reports its exit code, signal, timeout and
cancellation state. Progress and recovery use the same settled-exit predicate.
A settled unsuccessful exploratory attempt can be superseded by independently
verified output or a later passing requirement. Missing settlement information,
timeouts, cancellation, uncertain cleanup and uncertain side effects do not
become passing evidence.

The executor recognizes a collected Python exit as a known local outcome only
when no nested tool calls occurred. This matches terminal settlement; it does
not assert rollback or success. Nested tool effects, interruption and uncertain
cleanup cannot be cleared by Python's exit status.

Full readback of a runtime-observed command-produced output counts as progress
once per observed file version, as does readback after `file.write`/`file.patch`.
Repeated command observations, unchanged readbacks, and service snapshots do not
keep a stalled loop alive. Progress credit does not itself satisfy completion.

Checks with unknown dependencies remain conservatively invalidated by later
observed edits in the same turn. A model-provided label or a changed filename is
not proof that the edit is independent of a check. Execution permissions,
workspace trust and the hardline command floor remain unchanged.

## Requirement scope and bounded coverage

Incidental “find useful” wording, local numeric searches and local debugging do
not create research requirements. Fresh research can use owned successful web
search or page extraction with observed citations. Explicit requests to search
retain a search requirement, including after continuation; extraction does not
replace that request. Source-access failures and unobserved citations remain
incomplete evidence.

The automatic file contract retains at most eight output targets and its existing
serialization budget. Exceeding these file limits records `file-output-limit`,
not a task failure. The tracked files still require their normal evidence, and
completion additionally requires a current successful `file-output-coverage`
check covering **every output in the original request**. The completion feedback
asks the model to run that check using `terminal.run` or `execute_code`. Unrelated,
failed, stale or other-turn checks cannot satisfy coverage. Oversized requests,
unsafe paths, ambiguous targets, and missing required skills remain unresolved.
This fallback does not automatically inspect outputs omitted from the contract:
its coverage depends on the declared check actually testing the full request.

A passing literal `test -f path` or `test -s path` can retain evidence across an
unrelated materialized `file.write`, only when runtime file observations establish
its regular-file target. Writes to that target, compound commands, generic tests,
unknown paths and shell mutations retain conservative invalidation. This is not
a general dependency graph or a model-authorized exemption.

The 8 MiB bounded filesystem read limit remains in force; these changes do not
claim that large strict-content contracts or arbitrary validation dependencies
are solved. Ordinary outputs continue using their existing production evidence.
