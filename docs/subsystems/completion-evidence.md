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

Full readback of a runtime-observed command-produced output counts as progress
once per observed file version, as does readback after `file.write`/`file.patch`.
Repeated command observations, unchanged readbacks, and service snapshots do not
keep a stalled loop alive. Progress credit does not itself satisfy completion.

Checks with unknown dependencies remain conservatively invalidated by later
observed edits in the same turn. A model-provided label or a changed filename is
not proof that the edit is independent of a check. Execution permissions,
workspace trust and the hardline command floor remain unchanged.
