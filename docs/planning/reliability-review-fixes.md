# Reliability gap-review fixes

This focused follow-up corrects six gaps found when reviewing PR0–PR6 against the capability-routing plan. The live-provider assessment remains pending; these changes do not claim scientific accuracy or a live completion rate.

## Implemented behavior

- Affirmative research topics containing “how to” retain their file/delegation requirements. Quoted, hypothetical, example and negated actions remain inert. Multiple explicit skills in one clause or separate clauses are tracked independently; excessive references leave an explicit unmet requirement.
- Completion and delegation admission require delivered, ready instructions for every resolved requested skill. Additional skills use the existing bounded request/read/continuation receipt path.
- Foreground fresh research requires the same bounded source/claim table and observed-URL provenance as delegated research. Search success alone cannot complete the request. Retrieval/access metadata comes from runtime observations; semantic truth remains a separate assessment.
- A root research-and-save request creates a dependent report-delivery Step in the existing Task graph. Workers and synthesis keep their existing authority. Delivery receives only task.result.read, file.write and file.read from root-session visibility, retains trust and runtime approvals, and is restricted to the requested relative path. Unspecified targets use report.md/report.txt. It must read the accepted synthesis, write exactly its bytes and read them back before its result is accepted. Missing capabilities, denial, wrong bytes and missing readback keep the objective incomplete. Existing session/channel delivery names the verified path without attaching local files automatically.
- Explicit policy mixed with transient capability observations is retained for memory review rather than discarded or auto-promoted. Runtime-only observations remain excluded; unsupported rewrites of their evidence do not become user preferences.
- Discovery returns bounded descriptions/toolsets and ranks query matches deterministically. Recovery evaluation queries the original prompt and consumes returned metadata; expected IDs only score the result. The frozen corpus and labels are unchanged. A separate real-runtime test uses discovery feedback to choose the request/read calls across provider iterations. Scripted consumption is not a live model assessment.

## Security review

Report delivery is a root-request Task action, not a relaxation of the delegated-worker allowlist. It cannot delegate, run commands, write another target, override a denial or skip an inherited approval. Target checks also run at dispatch validation. Child Tasks do not gain this root delivery Step. The existing scheduler, spend limits, cancellation, leases, result ownership and channel delivery bindings retain control. Synthesis remains the primary research result; delivery is excluded from worker counts.

Regression coverage includes false completion without tools, uncited foreground research, multiple required skills, autonomous save across a runtime restart, denied/wrong-target/wrong-content/no-readback/claim-only delivery, exact-target approval policy, mixed memory policy, and query-based capability recovery. CLI and Telegram entry-point fixtures use the same autonomous delivery workflow. The packaged app fixture separately checks original-request delivery and a save-only follow-up after app restart.

## Validation

Validation ran in the existing clean detached checkout with the exact changed source/test/script files copied from the working branch and byte-compared afterwards. Unrelated user documentation and duplicate files in the original workspace were preserved. Initial sandbox runs blocked local sockets/PTYs; the authorized reruns passed. No dependency or lockfile change was made.

| Check | Result |
| --- | --- |
| Node / pnpm | v24.14.1 / 10.33.0 |
| Frozen offline install using the existing isolated store | Passed |
| Core typecheck and build (via packaging) | Passed |
| Full final core suite | 11,987 tests, 746 files passed |
| Final research release gate | 1,311 tests, 34 owning suites passed |
| Desktop typecheck / tests | Passed; 173 tests, 46 files |
| Source / distribution smoke | Passed |
| Runtime import / ESM audits | Passed |
| Rebuilt signed desktop package | Passed; automatic original-request delivery and restart/save-only checks passed |
| Diff whitespace check | Passed |

The unchanged routing corpus retains 90/90 held-out requested-tool recall, 15/15 primary-skill precision, and 15/24 primary-skill recall. All 26 development/held-out misses (including all nine held-out misses) recover in one query-based round with instruction reads. This is a regression evaluation of the existing frozen corpus, not a newly collected blind holdout or live model score.

The final source workflow uses one initial user request, three workers, one read-only synthesis, one report-delivery Step, five accepted results, three searches and 15 scripted provider calls. Restart occurs before delivery, without another user message or research batch. The packaged run independently verifies a completed Task and existing verified file before submitting a later save-only request after app restart. Its 17 workflow calls include that additional follow-up; this is not directly comparable to the original PR6 fixture's 13 calls ending at its first save. Across packaged scenarios there are 24 scripted provider calls and 17 tool results, including the expected missing-search rejection.

Detailed compact measurements: [source](../../evals/results/research-reliability-review-source-v1.json) and [package](../../evals/results/research-reliability-review-packaged-v1.json). The package record includes its runtime inventory digest and source-overlay hashes. A final regression additionally verifies that an accepted research result cannot waive a newly requested skill on a save-only follow-up.

Live-provider assessment still requires the previously requested provider/model, approved sources and spend ceiling (five scenarios, three repetitions each). No live model calls or real Telegram messages were made.
