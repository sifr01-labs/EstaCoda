# Run-limit live comparison — 2026-10-30

Tested before creating any implementation commit, on `ame/jev-assisted-routing`.

Baseline: `eb585bdc17aa2a1c52b7120389b5e78aea240a2f`, built before editing. Separate immutable compiled copies preserved both candidates. Model: configured Codex `gpt-6.1-sol`; Jev-assisted routing; same profile configuration, fixtures, tool policy, and provider; fallback routes disabled for comparison. All state and files were isolated from production. No mocked provider responses were used for these live cases.

## Results

| Build/workload | Runtime outcome | Main model calls | Main model tokens | Elapsed |
|---|---|---:|---:|---:|
| Foreground baseline | partially_completed | 45 | 387,677 | 135.1s |
| Foreground candidate | completed | 144 | 2,202,825 | 463.0s |
| Task baseline | waiting_for_input | 45 | 498,912 | 136.0s |
| Task candidate | completed | 56 | 663,736 | 176.0s |

The foreground baseline stopped at 45 calls after saving **17 of 52** correct decisions. The candidate saved **all 52 correct decisions**, preserved every input, wrote the required summary, and reported completion. Every output was checked against independently computed eligibility and refund amounts. The Task baseline stopped at 45 calls; the candidate finished in 56 calls with the correct result: 52 reviewed, 26 eligible, 130,450 cents. Both Task runs received the same profile requesting 120 steps / 90 minutes; the baseline silently retained its fixed 45-step / 30-minute defaults, whereas the candidate persisted the configured limits. The 1,000,000-token Task ceiling remained enforced.

These are controlled sequential case-review workloads, chosen to cross real existing caps. They establish that progressing work can finish beyond those caps. They do not establish a general speed, cost, or reasoning-quality improvement. Completing more work required more time and tokens; foreground token use rose substantially with accumulated history. Main-model pricing was unavailable, so no dollar-cost comparison is claimed. No live test ran past 30 minutes; duration behavior is covered by clock-controlled tests, not a 30-minute production measurement.

Small coding control: both builds fixed numeric-price handling, preserved the tests, and passed the real Node test command; baseline 25.1s / 7 calls, candidate 24.7s / 7 calls. That single sample is not evidence of a speed improvement.

## Limitations and diagnostic runs

An initial 52-case fixture used a placeholder output filename (`Rxxx.json`). Both builds reported incomplete output; the candidate nevertheless produced 52 correct actual files while the baseline stopped after 15. The final comparison removed that ambiguity and added an explicit `summary.json`; both builds were rerun on the identical corrected prompt. Diagnostic results are not substituted for final results.

A separate local-note lookup returned the correct facts and citation on both builds. The baseline reported completed (12.8s / 4 calls), while the candidate reported partially completed (16.9s / 5 calls). This is recorded as an unresolved completion-classification inconsistency, not counted as a passing candidate control. Neither run approached a run limit.

## Reproduction

Use `scripts/eval-run-limits-live.mjs` with `RUNTIME_CORE` pointing at an immutable built checkout, `RUN_ROOT` pointing at a fresh output directory, and `EVAL_HOME` pointing at an isolated profile home with test provider credentials. `EVAL_PROFILE` defaults to `default`; `CASES` selects comma-separated case IDs and `LANES=1` runs one case at a time. The harness independently checks artifacts and stores timing, outcomes, usage, and traces in the output directory. Do not commit credentials or raw traces.

For the foreground comparison, leave interactive limits at defaults. For `task-refund-audit`, use `runLimits.unattended` with `maxIterations:120`, `maxToolCalls:300`, `maxDurationMinutes:90` in both test profiles. The baseline ignores this previously unsupported configuration.

Compiled JavaScript digests (SHA-256 over sorted relative paths and bytes):

- `baseline`: `699a124307a0b1224b65859512681f1e88d812bdf2ec4c51e5278c8bac4e5e0e`
- `candidate1`: `976791c4ac558fbc45c1ff443d401fed17c5f8c6e8de8f851e5ee8a0357f1766`
- `candidate2`: `e17634a600c5ce7e1d7172a3f8340f39bd3da4932f20e392662f5228a16bf95e`

## Verification and risk

The initial full core run exercised 13,346 tests: 13,331 passed; 15 failed across 11 files. Two menu-order expectations needed the new reviewed action; the remaining failures were blocked local sockets/processes. All 225 tests in the affected ten-file rerun passed after fixing those expectations and granting the required local test permissions. Desktop unit tests passed across 48 files; the seven native terminal tests passed when rerun with PTY permission. English/Arabic desktop browser checks passed, including run-limit review/save and both host and Docker settings. Typecheck, build, source and distribution smoke, runtime-import audit, ESM audit, and diff checks were run; early typecheck failures were fixed and the dependent smoke checks rerun successfully.

Runtime limits and Task admission are security-sensitive. Unlimited foreground defaults can consume more provider capacity; explicit configured limits, spending controls, cancellation, request timeouts, no-progress/failure detection, trust, and approval enforcement remain in place. Unattended limits stay finite and Task ancestry accounting remains cumulative.
