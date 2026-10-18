# Exact-copy and preservation recovery — 2026-10-18

Base: `c4ac335d`. This patch extends the existing governed `file.write` tool; it does not add a router, new tool, or semantic grading subsystem.

## Implemented behavior

- `file.write sourceFile: { path }` copies the actual UTF-8 source after a successful materialized `file.read`. The runtime remembers and rechecks its digest internally. It preserves Unicode, CRLF, blank lines and trailing newlines without asking the model to transcribe a preview or obtain a hidden hash.
- Explicit copy requirements bind source equality as well as destination write/readback. Matching a wrong write to its own readback no longer establishes a correct copy. The completion loop can request repair; unresolved source mismatch cannot be marked completed or verified. Unrelated correct edits retain their verification.
- File tool guidance distinguishes display headings from content and instructs narrow edits to preserve protected fields/types, clarifying conflicting constraints before changing protected content.
- Persisted requirements accept the bounded copy contract. Restart follow-ups must reread their source. Accepted Task-result exports retain their existing integrity path.

## Evidence

The final compiled core passed **10/10 targeted live cases** with actual configured GPT/Jev calls, isolated workspaces/databases and unchanged approval rules:

| Cases | Outcome |
| --- | --- |
| Four original copy failures: two report restart copies, decision-file restart copy, Unicode/trailing-newline copy | 4/4 passed independent source/destination byte comparisons |
| Original nested JSON edit | Passed; job B, job order, numeric zero and string `001` preserved |
| Separate two-turn clarification scenario for the conflicting JSON request | Passed after explicit preservation direction |
| Previous relative-link audit and German-placeholder fixes | 2/2 passed |
| Authorization denial and restart supersession | 2/2 passed, including the expected blocked write |

Earlier development replays exposed an API design mistake: requiring the model to echo a digest that only internal metadata carried. The final API binds the digest internally. Earlier JSON replays also appropriately asked for clarification without modifying the input. The final original-case replay chose the minimal edit and preserved job B. Guidance improves this ambiguous case; it is not a deterministic verifier of arbitrary natural-language editing constraints.

[Machine-readable evidence](../../evals/results/exact-copy-recovery-2026-10-18.json) retains the synthetic prompts, inputs, outputs, hashes, tool decisions and tested source hashes. Original fixtures were not rewritten to improve the score. The clarification scenario is an additional case, not a replacement for the original one. This is **not** a new 120-case pass-rate measurement.

Final clean-checkout validation: **12,634 tests passed**, typecheck/build passed, runtime-import and ESM audits passed, and source/compiled smoke checks passed. Focused review checks covered 417 assertions before the final full suite. Locked dependency installation passed in the isolated checkout. The main checkout's unrelated duplicate declaration files prevent its broad typecheck; the validated checkout contains HEAD plus only this patch. The initial unrestricted full suite hit four subprocess startup timeouts and the intentional schema-snapshot change; the final full suite uses four workers, with assertions and timeouts unchanged.

## Boundaries and remaining limits

The source must have reached the authorized read handler; a supplied path alone grants no read. The bounded source-reference cache is local to the workspace tool instance. Current source bytes are rechecked before writing. Source and destination retain workspace/lease checks; source symlinks, binary/invalid UTF-8, unsaved editor differences and same-path copies fail. Write approval, overwrite and shrink protections remain in place. This is security-sensitive file access: the new source mode must never bypass those checks.

The previous SQLite-page timeout remains an external retrieval failure and was not counted as fixed or rerun here. Exact-copy checks describe observed execution bytes, not future external modifications. The Desktop app and gateway were not rebuilt or installed during this fix; live checks exercised the final isolated compiled core.
