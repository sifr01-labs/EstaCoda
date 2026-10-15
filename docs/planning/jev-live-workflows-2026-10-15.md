# Jev-assisted live workflow acceptance — 2026-10-15

**Result: 10 of 15 workflows passed the reviewed end-to-end criteria. Five exposed gaps.** This is a deliberately varied diagnostic sample, run once per workflow; it is not a statistical estimate of production reliability or a Jev-only accuracy score.

## What ran

- Source commit: `4b09c0cb18475aceeda2bd5398d250657a79371d`. All 1,957 files under `src`, `skills`, and `registries` in the isolated build matched that commit.
- Actual conversation model: `codex/gpt-6.1-sol`. Actual routing model: `typesafe/jev-1.13.0`, Jev-assisted mode.
- Real production `createRuntime`, tools, SQLite sessions, and `TaskScheduler`; actual provider responses, DDGS searches, and public-page fetches. No scripted model responses or mock web results.
- Temporary workspaces and isolated session databases. Credentials and installed DDGS came from the selected existing profile through normal runtime resolution. Selected profile configuration was checked unchanged after each test batch.
- CLI runtime entry, not the installed Desktop package or gateway. Browser was unconfigured; cron disabled; messaging, configuration, memory, MCP, dangerous and media toolsets disabled. Those surfaces were not tested.
- Foreground limits: 30 provider iterations, 60 tool calls, 240 seconds, with a 15-second finalization reserve. Production hardline, workspace and approval checks remained in place. The report-copy failure arose from the evidence contract, not a denied command.
- “Restart” below means disposing and recreating the runtime around the same persisted SQLite session, not restarting the gateway or machine.

[Machine-readable results, exact prompts, outputs and artifact hashes](../../evals/results/jev-live-workflows-2026-10-15.json).

## Workflow list and observed results

| # | Workflow | Reviewed result | Evidence |
|---|---|---|---|
| 1 | Ask whether the assistant can review source code | Pass | Answered without tools; completed normally. |
| 2 | Review a function pasted into the prompt, with file inspection prohibited | **Fail: incorrect status** | Correctly diagnosed `0 / 0` as `NaN`; runtime marked it blocked for missing read evidence. |
| 3 | Find the current decision among current and archived local notes | Pass, recovered error | Correct adapter, owner and retry restriction. Recovered after `terminal.inspect` rejected `ls -R`. |
| 4 | Fix numeric-string handling and run existing Node tests | Pass | Implementation changed; all three original tests passed, independently rerun. Test file unchanged. |
| 5 | Calculate paid revenue from CSV and save a report | Pass | East 180, West 120, total 300, four paid orders. File saved and read back. |
| 6 | Answer an Arabic inventory question from CSV | Pass | Correct out-of-stock product and total of 19, in Arabic; no web calls. |
| 7 | Read RFC 9110 and explain 401 versus 403, without search | **Fail: routing and extraction** | Required extraction initially omitted; recovered through discovery. Nine extractions returned the page prefix. No requested answer delivered. |
| 8 | Apply two installed skills to supplied facts without external actions | Pass | `researcher` and `research-discovery` selected. Concise response; only a skill read was called. |
| 9 | Research WebP versus AVIF and save a concise cited report | Pass | Three searches, two successful untruncated primary-page extracts, saved report and read-back. Key comparisons checked against retrieved text. |
| 10 | Three workers research accessible forms, then synthesize and save | **Fail: misleading deliverable** | Three workers, synthesis and delivery all completed; 5 accepted results; report saved and verified. Final document incorrectly retained a paragraph saying it had not been saved. |
| 11 | Recreate runtime and make an identical report copy | **Fail: incorrect completion** | `cp` + `cmp` succeeded; `file.read` read the copy; independently equal bytes. Runtime reported missing write evidence and partial completion. |
| 12 | Request revenue from a missing file | Pass: appropriate block | Reported the missing input, invented no numbers, created no file. |
| 13 | Rewrite supplied prose without tools | Pass | Concise rewrite, no tools, completed. |
| 14 | Recover from a 404 using a long fallback standards document | **Fail: unsupported attribution** | Recovered the page and produced a plausible answer, but cited a section absent from the retrieved prefix. |
| 15 | Recover from a 404 using a short primary documentation page | Pass, recovered error | Disclosed the failed URL; read Google’s WebP page and answered from its explicit lossy-transparency statement. |

An initial two-skill test incorrectly named a nonexistent “Technical Writer” skill. It was corrected to two installed skills and is excluded from the 15-workflow denominator. Its original trace is retained locally; the assistant disclosed missing skills rather than claiming to have used them.

Initial automated predicates checked content or artifact presence in several cases. Review additionally checked runtime status and source support. That review downgraded cases 2, 10, 11 and 14; a correct-looking answer or existing file was not sufficient to pass.

## Findings and smallest next changes

### 1. Negative instructions can create a false completion requirement

`deriveExecutionCompletionFloor` scopes negation for mutation checks, but its read and execution-surface checks use normalized whole-prompt text. In case 2, “Do not inspect files…” introduces the execution surface that causes a required read, despite the code being supplied inline.

Deterministic reproduction against the tested build:

- Original inline-review prompt: completion floor `read`.
- Same prompt with the prohibited-action sentence removed: completion floor `none`.

Scope read requirements to affirmative requests and distinguish supplied content from external resources. Preserve actual repository-read requirements. Relevant code: `src/runtime/execution-outcome.ts`.

### 2. Successful shell file operations do not satisfy the narrow file contract

Case 11 created and verified an identical copy, but `fileOutputEvidence` only recognizes successful `file.write`/`file.patch` receipts followed by matching `file.read` evidence. The assistant chose a normal copy command, then received a misleading “no successful write or patch” outcome.

Prefer the existing verifiable file path in provider guidance and recovery, or add narrowly scoped execution-owned evidence for supported file operations. Do not accept arbitrary shell prose or an old file as proof. Relevant code: `src/runtime/file-output-evidence.ts`.

### 3. Direct URL selection still has a false negative

For case 7, Jev scored `web.extract` at **0.29**, rejecting it despite the direct read request. The initial tools were status and recovery tools. Discovery/request correctly recovered extraction on a later iteration, preserving the execution boundary.

Add this wording as a regression and improve direct-URL requirement handling. Keep “do not search” separate from “do not read this supplied URL.” This is a concrete counterexample to treating previous corpus success as complete calibration.

### 4. Long-page reading lacks a usable continuation path

`web.extract` clamps requested output to the configured limit (24,000 characters in these runs). Its `text` argument is a URL-extraction fallback, not a content query. Fragment URLs did not target sections. Raising `maxContentChars` could not reveal later sections.

Case 7 repeatedly fetched the prefix and ended at the no-progress limit. Case 14 fetched the same prefix, then cited §15.5.5 even though the returned text ended in §2.5. Correct general knowledge does not establish that the cited section was inspected.

Provide bounded section retrieval, within-document search or continuation through the existing extraction surface, with explicit truncation and source provenance. Test that the requested section is actually returned, and that cached/repeated prefixes are not treated as new evidence. Relevant code: `src/tools/web-tools.ts` and the extraction provider.

### 5. Synthesis and delivery instructions still conflict

The model-created synthesis objective in case 10 instructed the synthesizer to write and verify the report. The task graph separately assigned exact-content writing and verification to a delivery step. The synthesizer had no file tools and included this operational blocker in the report:

> “forms-checklist.md has not been saved or read back”

Delivery subsequently saved those exact bytes, including the now-false statement. The task and file receipts were correct; the deliverable’s operational status was wrong.

Make the synthesis contract explicitly content-only when delivery is owned by a subsequent step. Keep operational status outside the accepted report body. Validate this with the real multi-worker path, not just a file-exists assertion. Preserve exact-content delivery integrity rather than silently rewriting accepted output during export.

## Interpretation

For the 15 included workflows, the usage ledger records **79 conversation-model calls and 57 Jev request batches**. All 57 recorded Jev batches have state `responded`. Routing status records contain 28 `uncertain` fallbacks and 13 without fallback, across foreground, worker, synthesis, delivery and discovery stages. These are stage-event counts, not counts of failed tasks.

There was no recorded Jev transport, authentication or billing failure in these runs. Candidate uncertainty remains common, and one direct URL required recovery. Most substantive failures were downstream completion, extraction or task-contract defects.

The result supports continued real use on tested simple workflows, with clear limits. It does **not** establish perfect calibration, reliable long-document research, a production success percentage, or end-to-end Desktop/Telegram acceptance. No installed app or gateway update was performed for this test round, and no production source fix was made.

The exact prompts in this report are now exposed regression examples. Future calibration should retain them but use fresh, independently written workflows for acceptance.
