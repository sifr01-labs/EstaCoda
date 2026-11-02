# Learning from a correction: live skill review test

On 2026-11-02, a real Codex `gpt-6.1-sol` run generated a useful skill patch after one corrected task. The unchanged skill passed 2/6 held-out runs; the exact model-written candidate passed 6/6. Both repetitions agreed. Promotion without approval was blocked, and no live skill was changed.

This demonstrates targeted learning from an explicit correction to a deliberately stale procedure. It does not establish general spontaneous self-improvement, a Hermes performance ranking, or permission to promote the patch.

## Implementation

The existing background reviewer now receives bounded, redacted conversation and tool evidence from the current profile/session, the current skill, and up to two contained reference excerpts. One clear correction can justify a draft. The reviewer still makes one tool-free model request, may abstain, and submits patches through the existing proposal service.

Replay is ephemeral, capped at 24 messages/24,000 content characters, and preserves the latest two user messages. Individual messages and reference excerpts are capped at 4,000 characters with explicit clipping. System messages are excluded. Reference reads reject symlinks and paths outside the skill. Fresh evidence can trigger review after an abstention, within a shared three-attempt daily cap (or lower configured limit). Matching task evidence and explicit approval remain mandatory for learned patch promotion.

## Protocol

- Baseline runtime: `407fb6363834db51224b3b30b0f90d9ebf03aad4` on `ame/jev-assisted-routing`.
- Candidate runtime: that revision plus the two production files pinned by SHA-256 in [manifest.json](../../evals/results/skill-review-live-2026-11-02/manifest.json).
- Model: actual usage records show `codex/gpt-6.1-sol` throughout; no fallback routes.
- Fourteen real tasks, each using a fresh profile/session/workspace and real file tools: two training runs and twelve held-out runs.
- Foreground budgets: 16 provider iterations, 24 tool calls, 180 seconds, 4,000 output tokens; temperature 0. Review retains its separate 20-second/1,500-output-token ceiling.
- Fixture skill: inventory reconciliation with a deliberately stale “last row wins because exports are chronological” rule.
- Training: one explicit user correction points to an exporter contract. Greatest numeric revision wins; last occurrence breaks ties; filter deleted winners after selection; preserve zero/negative quantities. An operator-owned verifier checks the saved output.
- Held-out evaluation: three frozen CSV tasks, twice each with alternating arm order. No training contract, verifier, or expected answer is present in their workspaces. Both arms use the updated runtime, isolating the effect of the skill patch. The unchanged or learned skill is installed only as an isolated evaluation fixture.
- Expected outputs were frozen before model execution. An external grader checks exact JSON and unchanged fixture inputs. The candidate is solely the background reviewer's patch; no manual revision was made.

The tasks use realistic file-processing operations on small synthetic fixtures, rather than production customer data.

## Results

| Check | Original | Updated |
| --- | --- | --- |
| Corrected training task | Passed | Passed |
| Automatic review calls after one training session | 0 | 1 |
| Automatic proposals | 0 | 1 |
| Out-of-order revisions, two repetitions | 0/2 | 2/2 |
| Revision ties and tombstones, two repetitions | 0/2 | 2/2 |
| Chronological regression, two repetitions | 2/2 | 2/2 |
| Total held-out task passes | 2/6 | 6/6 |

The reviewer replaced the stale rule with:

> For each sku, select the row with the greatest numeric revision; if revisions tie, select the last occurrence in the file. File order is not chronological. Only after selecting winners, omit entries whose deleted value is true so that lower-revision rows cannot resurrect newer tombstones.

All fourteen runs left their fixture inputs and installed skill unchanged. The new proposal required human approval and task evaluation, disallowed automatic promotion, and carried the original skill content hash. An actual unapproved promotion attempt returned `ok: false`: “Skill patch proposal requires explicit approval before promotion.”

Held-out foreground usage was 33 provider calls/186,391 recorded total tokens for the original skill and 31 calls/174,819 tokens for the candidate. Aggregate elapsed time was 114.8 seconds versus 123.8 seconds respectively. The candidate improved correctness here, but did not establish a speed advantage. The one review used 2,712 input and 135 output tokens. Pricing was incomplete, so no dollar-cost claim is made.

## Evidence and reproduction

- [Summary and all paired outcomes](../../evals/results/skill-review-live-2026-11-02/summary.json)
- [Frozen inputs and expected outputs](../../evals/results/skill-review-live-2026-11-02/fixtures.json)
- [Unedited learned candidate](../../evals/results/skill-review-live-2026-11-02/candidate.md)
- [New runtime proposal and learning records](../../evals/results/skill-review-live-2026-11-02/after-learning/learning.json)
- [Runner](../../evals/results/skill-review-live-2026-11-02/run.mjs); adjacent run directories contain redacted transcripts, results and usage.
- [Validation record](../../evals/results/skill-review-live-2026-11-02/validation.json)

The runner makes paid provider calls using the selected profile's configured Codex account. From this repository, run it with `node --import tsx evals/results/skill-review-live-2026-11-02/run.mjs /private/tmp/<new-directory>`. Archive the recorded evidence first: a rerun replaces the adjacent results. Temporary task credentials exclude refresh tokens and are removed after each task. The recorded run left no task credential files; exported artifacts passed a credential-pattern scan.

## Repository validation

The final source passed typechecking and all 13,433 tests across 786 files. Targeted skill tests also passed (48 tests), including single-session drafting, correction retention across a long tool history, secret redaction, reference containment, profile isolation, repeated-evidence suppression, spending caps and retained approval gates. Build, runtime-import audit and ESM audit passed. The complete command record, including smoke checks and frozen dependency installation, is linked above.

## Limits and risk

One learned change and three task types, even repeated, are a small controlled experiment. This tests correction capture and reuse, not discovering an unknown defect without user guidance. It does not test learning a new skill, long-term retention across upgrades, or broad regression freedom. The paired runs are research evidence; they were not submitted as a certified promotion evaluation.

Richer review inputs increase exposure to untrusted conversation/tool content. The implementation bounds and redacts it, validates profile ownership, confines reference reads, rejects recognized secrets in generated patches, and keeps review tool-free. Redaction cannot guarantee removal of every sensitive fact, and a model can still propose a wrong lesson. Explicit review, content binding, task-evaluation gates and the absence of automatic promotion remain essential boundaries.
