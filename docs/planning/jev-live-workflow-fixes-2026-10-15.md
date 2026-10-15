# Live workflow reliability fixes — 2026-10-15

This change addresses the five failures in the [15-workflow baseline](jev-live-workflows-2026-10-15.md). It preserves Jev's calibrated scores and thresholds. Explicit user requirements and host-owned execution prerequisites take precedence over semantic omissions, within the authorized session catalog.

## Implemented behavior

- **Completion classification:** prohibited file inspection and fenced/quoted examples cannot create read obligations. Affirmative repository and named-file reads still require execution evidence, including when a later clause prohibits edits.
- **File delivery:** explicit report-copy destinations are recognized. The prompt explains the supported write/patch plus complete-readback path. The existing bounded completion repair loop now also covers file-only requests, including after restart. A shell command or an old file is still insufficient evidence; denied actions still prevent repair retries.
- **Direct URLs:** an affirmative request to read a URL retains `web.extract`, even if Jev rejects it. A prohibition on search remains binding.
- **Long sources:** the existing extraction tool supports literal query excerpts and character-offset continuation. Output and searched-source limits remain bounded. Returned metadata distinguishes partial views from truncated upstream content; only returned passages support citations. Cache keys include the requested window.
- **Synthesis:** when an actual downstream delivery step owns saving, the synthesizer's objective explicitly requests report content without file-operation status. Accepted report bytes are still delivered exactly, not silently rewritten. Synthesis is also instructed to include the retained source appendix within a requested word budget; this remains model guidance, not a hard word-count gate.
- **Delivery preflight:** a missing assigned output is normalized through its existing parent directory, so an existence check can report missing content without becoming an authorization denial. Unnamed turn-level assessments retain risk ceilings but do not pretend to be file operations. Actual tool calls still require an exact delivery target; outside targets and symlinks remain blocked.
- **Dependency reads:** host-owned step prerequisites preserve `task.result.read` for dependent synthesis and delivery. This fixed an additional failure found during live validation: Jev had confidently rejected the only available synthesis tool, leaving the model with worker summaries instead of the full accepted reports.

## Review and safety

Execution authority, workspace trust, approvals, URL/redirect restrictions, profile scoping, model credentials, and source-evidence acceptance remain enforced. The delivery ceiling now distinguishes an unnamed turn assessment from an actual tool operation, and missing-file reads use the same canonical target identity as writes. Required tools are intersected with the session catalog and availability checks; they are not accepted from message metadata. Jev selection retains exact tool prohibitions and existing schema/evidence gates. Source matching escapes regex syntax and preserves Unicode offsets. Copy and delivery continue to require real file receipts and matching readback.

Regression coverage includes negative instructions, real reads, copy targets, unavailable required tools, explicit prohibitions, cache separation, Unicode matching, configured extraction providers, failed source matches, stale files after restart, denied writes, synthesis objectives that mistakenly ask to save, pre-write existence checks, and delivery through an outside symlink. Exactly-qualified worker counts are also retained as explicit requirements. Existing CLI and Telegram acceptance tests cover the expanded repair path.

## Validation scope

Validation uses a clean isolated copy of base `4b09c0cb` plus the focused patch; unrelated Desktop/model-setup changes in the working checkout are excluded. Live workflows use real `codex/gpt-6.1-sol`, `typesafe/jev-1.13.0`, DDGS, public-page extraction, SQLite sessions and the production task scheduler. They exercise the compiled CLI runtime, not the installed Desktop package or gateway. Selected profile configuration is checked unchanged.

The original baseline passed 10/15. The first fixed rerun passed 14/15 and exposed the dependency-reader omission described above. That failure was retained and used to add a prerequisite regression before a further live rerun. That rerun exposed a missing-output preflight identity problem, now covered by a durable delivery test. A subsequent complete run saved and verified all five steps, but its automatic evidence appendix pushed the report to 938 words against an under-800 request; synthesis guidance now explicitly budgets for that appendix. The next run encountered a network-class worker failure and correctly delivered a 599-word partial report identifying missing keyboard/focus coverage. That run remains recorded and was repeated without changing source. Four newly written workflows cover supplied-code review, a YAML read, an exact multilingual copy, and a different long standards document. These are diagnostic samples, not a production reliability estimate or proof of perfect calibration.

## Automated checks

The final isolated source passed TypeScript checking, all **12,496 tests in 764 files**, source smoke, build, runtime-import and ESM audits, and compiled-runtime smoke. Frozen dependency installation and `git diff --check` also passed. The full test command used `--testTimeout=30000`: the default five-second timeout was exceeded by existing model-catalog tests accessing `models.dev`; no test or production timeout was changed to hide that limitation.

Validation excludes the main checkout's unrelated Desktop/model-setup edits and pre-existing duplicate `* 2.ts` files. An attempted main-checkout build hit duplicate `bidi-js` declarations; the focused patch was built and tested successfully in the isolated copy. The installed application and gateway were not updated.

## Measured live result

The latest reviewed outcomes passed **19/19 distinct workflows**: the original 15 regression workflows plus four fresh variants. This is a collection of outcomes across incremental fixes, **not 19 tests all rerun together on final source**, and not a production success-rate estimate. There were 23 workflow attempts across the fix rounds; intermediate failures remain in the [machine-readable evidence](../../evals/results/jev-live-workflow-fixes-2026-10-15.json).

The final unchanged-source repeat completed all three workers, synthesis, and delivery in **162 seconds**. The report contains **612 whitespace-delimited words including its source appendix**, with claims checked against retrieved W3C/MDN passages. It contains no false file-saving blocker. The 5,183-byte file's write digest and complete readback digest both match `2e844eb35a55041e518e1c8ac6b086c2ef99d17c0359223aa37f85874c8ff831`.

Across these fix-round attempts, the ledger records 241 conversation-model calls and 119 Jev batches; all 119 Jev batches responded. Routing events include 54 candidate-level `uncertain` fallbacks and 41 without fallback. These are stage events across parent and child work, not failed-workflow counts. The recorded network-class worker failure is retained; successful routing does not guarantee successful downstream execution.

No further defect in the focused patch was identified during review. Remaining limits include variable provider/network availability, model-dependent writing and citation quality, and the separate need to rebuild and test the installed Desktop application and gateway. The evidence does not establish perfect Jev calibration.
