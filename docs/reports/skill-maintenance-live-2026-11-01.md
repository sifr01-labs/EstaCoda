# Governed skill maintenance: live verification, 2026-11-01

The updated runtime picked up an operator's changed skill instructions between turns and produced the correct reconciliation. The pre-change runtime continued using the previous procedure while reporting completion. This demonstrates a catalog-freshness fix on a live task, not a general intelligence gain or a Hermes performance ranking.

## Matched live workflow

Baseline: `72bcb20da00ffaeea72c096cc19913d93fb47ec6`. Candidate: the working-tree skill-maintenance change accompanying this report. Both ran Codex `gpt-6.1-sol` with no fallback, fresh profile homes, the same input files and prompts, and limits of 16 provider iterations, 24 tool calls, 180 seconds and 4,000 output tokens per turn. The baseline ran first. Temporary workspaces isolate task state; they are not OS security sandboxes.

The agent performed actual file reads, computations, JSON writes and readbacks. The data was a constructed, non-private invoice-export fixture, not a customer's production accounting data. Each batch contained 26 rows with duplicate IDs, credits, disputed and void rows, and USD/EUR amounts. Expected outputs were calculated outside the agent and frozen before the measured runs.

Turn one used policy v1. Between turns, the operator changed the same `ledger-close` skill file to v2, excluding disputed rows and subtracting credits. Turn two asked the agent to use the skill's current procedure, without manually refreshing the catalog. Skill autonomy was disabled in this matched pair to isolate refresh behavior.

| Measure | Before | After |
| --- | --- | --- |
| First task: exact expected JSON | Pass | Pass |
| Second task after procedure update | **Fail: stale v1** | **Pass: current v2** |
| Total verified tasks | 1/2 | 2/2 |
| Automatic catalog change notices | 0 | 1, `ledger-close` changed |
| Foreground provider calls | 17 | 17 |
| Tool calls | 14 | 14 |
| Combined task time | 73.4 s | 68.1 s |

The baseline's second result included disputed items and positive credits: USD **443.01**, EUR **211.66**, policy `v1`. The candidate produced the required USD **241.77**, EUR **68.40**, policy `v2`, with the exact expected included IDs. Both claimed completion, so the external file grader was necessary to distinguish them. These counts and times are observations, not reliable speed or efficiency estimates. The initial candidate also passed 2/2 (12 provider calls, 10 tool calls, 37.6 seconds). It was repeated after final visibility/storage/quota hardening; the table uses that final attempt, and both transcripts are retained.

An earlier setup attempt declared the nonexistent `shell-read` toolset. The loader correctly rejected the fixture, and the baseline could not perform the task. That attempt was retained locally and excluded. Both measured arms used the corrected, loader-validated `shell-readonly` declaration. No expected answers or task requirements were changed after seeing measured results.

## Executed proposal evaluation

The new operator-only command, `estacoda proposal test <id> <task-suite.json>`, ran four real provider requests: two cases, each with the baseline and proposed skill. Expected JSON stayed outside model context. The proposed change was the operator's known v1-to-v2 policy update; it was not discovered by the learning model.

- Baseline: 0/2 exact answers under the new policy.
- Candidate: 2/2 exact answers.
- Evidence provenance: `runner_executed`.
- Promotion without approval: blocked.
- Live source skill after evaluation: unchanged.

This runner executes bounded **tool-free** extraction/classification/transformation tasks. Its output/safety checks do not establish browser, filesystem or deployment competence. Imported reports remain explicitly `operator_attested`. Both paths retain approval, content-hash and non-regression gates. Starting a rerun invalidates old grades and approval; a tie or failure cannot leave an older passing grade promotable.

## Automatic review

Two additional live sessions used policy v2 in proactive mode. Both produced correct files; one completed after recovering from a tool error. Both were recorded as successful learning outcomes. Their different tasks aggregated under the same skill definition, with two independent session occurrences.

A background review attempt was recorded with status `abstained`; no proposal or live skill edit resulted. The retained evidence captures the attempt and abstention, not its separate provider-usage receipt. This demonstrates activation and conservative non-mutation, not automatically discovered improvement. Unit tests separately verify draft creation, cancellation, cooldowns, shared-profile quota claims, successful-task review, missing-workflow review proposals and promotion gates.

Automatic review remains limited to proactive/autonomous modes and repeated observations across sessions. It does not silently promote changes, synthesize executable new skills, run while the application is closed, or automatically detect every correction in ordinary conversation. Recorded routing-correction candidates are reviewable. A good skill may correctly produce no draft.

## Implementation and safety

- Recovered completion is a learning success; an ordinary standalone `diff` result does not become a recovery lesson. Failed declared checks remain failures.
- Catalog scans happen at turn boundaries. Same-name edits, removal, invalid definitions and archived lifecycle state are revalidated. Notices include only visible skills; existing execution authority still applies.
- Review is deferred until foreground completion and is aborted for subsequent foreground work or shutdown. Profile-local learning records and atomic claims prevent competing runtimes from duplicating draft attempts. Cancellation consumes the daily attempt/cooldown. Old workspace learning files are not implicitly imported across profiles.
- Drafting retains bounded requests, existing spend attribution, source checks, human approval and task-evaluation gates. It receives skill text and compact diagnostic labels, not raw conversation/tool output.
- The evaluation command pins one profile for source loading, credential resolution, accounting and result recording. Fixtures never supply executable grader code. Outcomes are graded outside the model; source/proposal versions are checked again after execution.

## Evidence and reproduction

Committed evidence: [summary and exact outputs](../../evals/results/skill-maintenance-live-2026-11-01/summary.json), [fixtures and both skill versions](../../evals/results/skill-maintenance-live-2026-11-01/fixture.json), [task evaluation suite](../../evals/results/skill-maintenance-live-2026-11-01/task-suite.json), and transcripts/provider answer artifacts in the same directory. Transcripts omit streaming-token noise and replace machine-specific source/workspace prefixes. They contain only fresh benchmark work.

The directory includes reproduction scripts. From the repository, use a new absolute temporary directory as the last argument:

```text
node --import tsx evals/results/skill-maintenance-live-2026-11-01/prepare.mjs /private/tmp/new-skill-maintenance-run
node --import tsx evals/results/skill-maintenance-live-2026-11-01/run.mjs before /private/tmp/new-skill-maintenance-run
node --import tsx evals/results/skill-maintenance-live-2026-11-01/run.mjs after /private/tmp/new-skill-maintenance-run
node --import tsx evals/results/skill-maintenance-live-2026-11-01/evaluate.mjs /private/tmp/new-skill-maintenance-run
node --import tsx evals/results/skill-maintenance-live-2026-11-01/review.mjs /private/tmp/new-skill-maintenance-run
```

These explicitly paid live scripts require a configured, valid Codex OAuth account. They copy only its access token into fresh homes and remove those temporary credential files on normal completion; they do not copy existing conversations, memories or personal skills. Inspect any interrupted run before retaining its home directory.

Validation results are recorded in `validation.json` beside the summary. An initial sandboxed full test run was unable to bind local sockets; a subsequent full run passed 13,427 tests with local IPC access. After the final changes and one additional regression case, 13,426 tests passed and two CLI tests timed out under concurrent load; all three tests in that file passed on isolated rerun. No timing threshold or expected result was weakened. Both source and packaged smoke passed 14/14 cases, along with typecheck, build, frozen-lockfile installation and import audits. No Hermes run was performed, and this evidence does not establish general automatic self-improvement or a cross-harness winner.
