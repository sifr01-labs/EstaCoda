# Durable research read recovery: implementation and live validation

The updated runtime completed a real source investigation that the baseline paused after rejecting useful research. Both versions encountered the same deliberately seeded Git and grep input errors and successfully corrected them. The updated version accepted the research with a limitation notice, completed the second worker, and synthesized findings from both codebases.

This validates one recovery path. It is not a rerun of the complete Telegram/DeepSeek investigation, a general research-quality benchmark, or a performance comparison against running Hermes.

## Focused change

`src/tasks/agent-step-executor.ts` treats authorized failures from the five existing local inspection/read/search tools as limitations when the worker has a delegated research contract and a repository-evidence requirement. It does not require a successful retry with identical arguments. The accepted result carries a bounded notice naming the failed tool types, without copying error bodies, paths or arguments.

Successful discovery, file reads and cited repository references are still required. Normal completion and the existing grounding, approval, security and result-capture checks still apply. Denied calls, unavailable tools, uncertain side effects, mutations and stopped runs remain outside this exception. Network-source recovery rules are unchanged. Failed observations never become successful evidence.

The same predicate applies before answer acceptance and at durable settlement. No tools, configuration flags, dependencies, approval bypasses or new subsystems were introduced.

## Live experiment

- Baseline runtime: `c7d656c614d9acf5b9649148fa2d6d6e8c5b3c4b`.
- Updated runtime: the baseline plus the executor change recorded by SHA-256 in the manifest.
- Both use Codex `gpt-6.1-sol`, no fallback, fresh isolated profiles and SQLite sessions, identical objectives, curated source files and provider budgets.
- The two workers inspect the actual EstaCoda executor/grounding implementation and Hermes delegation/turn-loop implementation. Hermes source is pinned to `5e7c2b254d414e4e25105231f818f385fee67469`.
- Both arms inspect the same updated source snapshot; this isolates runtime acceptance behavior from subject-code differences. The fixture Git revision identifies the fixture, not an upstream repository revision.
- The EstaCoda worker is explicitly asked to try `git log -1` and grep with an empty `max_filesize` once, then recover using allowed reads. These are real tool failures, not fabricated tool results. Their occurrence is induced rather than spontaneous.
- The harness creates the fixed two-worker/synthesis graph through `DurableDelegationService`, then runs the production `TaskScheduler` and `AgentStepExecutor` with real model calls. It does not test whether a foreground model chooses to delegate.
- Workers are read-only. They execute no upstream tests. The independently run repository validation below checks the implementation patch.

| Observation | Baseline | Updated |
| --- | --- | --- |
| Both seeded read failures occurred | Yes | Yes |
| Corrected Git and grep calls succeeded | Yes | Yes |
| EstaCoda report accepted | No; 7,465-byte diagnostic draft | Yes |
| Final task state | Waiting for input: research recovery required | Completed |
| Accepted worker reports | 0 | 2 |
| Accepted synthesis | None | 7,064 bytes |
| Completion-validation outcomes | 1 rejection | 3 acceptances, no repair |
| Read-error notice delivered to synthesis | No accepted input | Yes |
| Final report cites both codebases and discloses read errors | No final report | Yes |
| Provider calls | 18 | 32 |
| Reported total tokens | 191,681 | 354,414 |
| Elapsed time | 85 seconds, stopped at first worker | 183 seconds, full task |
| Input files unchanged | Yes | Yes |

The baseline failed with `tool-error` after producing and unsuccessfully validating its draft; the task then waited for recovery rather than continuing its remaining steps. The updated EstaCoda worker completed in 17 calls, the Hermes worker in 12, and synthesis in 3. Synthesis actually read both accepted result bodies, including the runtime-added read-error notice. The final report retained that limitation.

The updated run did more work, so total time and token counts are not efficiency scores. Pricing was unavailable; recorded zero cost estimates do not mean free execution. Full repository checks overlapped portions of these runs, so timings are descriptive only.

## Validation and risk

All 133 focused tests passed. The full suite passed **13,456 tests across 786 files**. Node/pnpm version checks, frozen dependency installation, typechecking, source smoke, build, runtime-import audit, ESM audit, distribution smoke and diff checks passed.

The first restricted full-suite run could not open IPC/loopback test sockets (13 failures); the unrestricted rerun passed. The first frozen install lacked registry access; the unrestricted retry reported the lockfile and dependencies already current. These environment failures are retained in the validation record.

An initial baseline attempt could not reach the model and produced network failures rather than research. Its exporter also initially closed SQLite before reading evidence; export was recovered from the persisted database and the runner cleanup order corrected. This attempt is retained separately as `network-blocked-before` and is excluded from the comparison. No production change was made between the completed paired runs. Temporary credentials were removed; exported artifacts were checked for credential patterns and private absolute paths.

Risk: accepting a report with read limitations is not proof of complete factual support. The existing repository gate checks minimum successful provenance, not every requested symbol or claim. The final report itself identifies that limitation. No failed or permission-denied read is authorized or counted as evidence by this change. An original-host Telegram run, broader coverage checks and repeated investigations remain separate validation work.

## Evidence and reproduction

- [Machine-readable comparison](../../evals/results/research-read-recovery-live-2026-11-02/comparison.json)
- [Actual synthesized report](../../evals/results/research-read-recovery-live-2026-11-02/REPORT.md)
- [Pinned inputs, prompts and source hashes](../../evals/results/research-read-recovery-live-2026-11-02/manifest.json)
- [Live runner](../../evals/results/research-read-recovery-live-2026-11-02/run.mjs)
- [Receipt grader](../../evals/results/research-read-recovery-live-2026-11-02/grade.py)
- [Validation record](../../evals/results/research-read-recovery-live-2026-11-02/validation.json)

The runner uses the selected profile's Codex credential for isolated fresh sessions. Run from the repository with `node --import tsx evals/results/research-read-recovery-live-2026-11-02/run.mjs /private/tmp/<new-directory> prepare`, followed by `before` and `after` with the same directory. Preparation downloads pinned public Hermes source when not already supplied and archives the pinned baseline runtime. Provider calls require network access. Archive existing evidence first: the runner writes adjacent evidence files. Run `python3 evals/results/research-read-recovery-live-2026-11-02/grade.py` to grade the stored receipts; grading makes no model calls.
