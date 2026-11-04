# Delegated lifecycle: live before/after evidence

Baseline: `bed689970f442caa9cf44432eeeec30bed9f05de`. Updated runtime source hashes are recorded in each packet's manifest. Both arms used the configured Codex account with `gpt-6.1-sol`, fresh profiles, identical subject source, actual repository tests, and the production planner, workers, scheduler and tools. No personal skills or existing conversations were copied. No Telegram messages were sent.

The evidence establishes specific preservation, budget and learning changes. It does **not** establish general automatic self-improvement, a performance win over Hermes, or uniformly seamless task completion.

## Initial matched cases

| Task | Baseline | Updated | Provider requests, before → after |
|---|---|---|---:|
| Original DeepSeek comparison request | Partial. One of three investigations accepted; two token overruns lost their reports | Partial. Two investigations accepted; the third preserved diagnostically after upstream prerequisite failures | 123 → 100 |
| Cancellation and late-result repository audit | Both investigations accepted; synthesis and verified export completed | Both investigations accepted; synthesis and verified export completed | 55 → 63 |
| Deliberately small 160,000-token worker allowance | Failed. Worker used 659,452 tokens; no result retained | Partial. Worker stopped at 31,963 tokens; qualified diagnostic draft retained | 43 → 10 |
| Ledger verification with an outdated local skill | Partial task, but parent learning had already recorded success at dispatch | Completed task; no parent success observation at handoff; learning recorded settled results | 17 → 14 |

The original comparison took 547 seconds before and 561 seconds after. Recorded input fell from 3,240,799 to 2,072,156 tokens, but elapsed time did not improve. The cancellation audit took 321 versus 304 seconds while input **increased** from 948,006 to 1,261,448 tokens. These single runs do not establish a general efficiency advantage. Provider pricing was incomplete, so this packet makes no dollar-cost claim.

Elapsed run time includes profile setup and a bounded wait of up to 70 seconds for auxiliary learning; it is not normalized production latency. Task creation-to-settlement duration is separately recorded where available. Provider totals include foreground, delegated and auxiliary requests.

The small-budget case demonstrates conservative stopping and retention, **not** successful completion within 160,000 tokens. Its updated draft lacks required tests and remained unaccepted. The parent chose different plan shapes across arms; deterministic regressions separately verify the accounting invariants.

Both ledger runs independently produced net revenue 170 and changed the local skill to subtract positive refund amounts. The improvement demonstrated here is outcome attribution: the baseline prematurely learned success from dispatch; the updated parent waited for actual settlement and attached result references. One correction is not a held-out performance evaluation. Child skill-use telemetry remains per-turn; the parent `settledTasks` observation records the objective outcome.

For every completed export, the on-disk report hash matched an accepted synthesis result. Original EstaCoda fixture files remained unchanged in all four matched cases. Packet Markdown is redacted and trailing whitespace is normalized; recorded hashes refer to original result/export bytes before redaction.

## Prepared-environment repeat and pilots

The first comparison had JavaScript dependencies installed without lifecycle scripts, but Harness required a native host addon. That absence was disclosed, and the resulting diagnostic was retained. Before the repeat, the addon was built using Harness's reviewed `native/system/scripts/build.ts --host-addon-only` for **both** arms.

The final prepared repeat still finished **partial in both arms**:

| Measurement | Baseline | Updated |
|---|---:|---:|
| Accepted investigations | 2 of 3 | 2 of 3 |
| Failed investigation | Timeout | Repository-evidence contract |
| Diagnostic retained | 1,369 bytes | 10,426 bytes |
| Provider requests | 78 | 70 |
| Recorded input tokens | 1,372,903 (usage incomplete) | 1,591,474 (usage complete) |
| Overall elapsed time | 502 seconds | 625 seconds |
| Task creation to settlement | 444 seconds | 550 seconds |
| Verified exported report | 22,520 bytes | 31,073 bytes |

The baseline already preserved a short timeout diagnostic. Therefore this repeat does **not** demonstrate that diagnostic preservation was wholly absent before the patch. The token-limit preservation difference is demonstrated by the small-budget case and deterministic settlement tests. Fewer requests in this repeat did not produce lower recorded input or elapsed time; incomplete baseline usage also limits that comparison.

The updated Harness worker ran **99 passing tests across five files**, but its 10,426-byte report was rejected by the existing `researchEvidenceFailure` repository-evidence check in `src/tasks/agent-step-executor.ts`. That check requires successful file discovery, a file read, and a matching source reference. Much of this worker's source investigation used Python reads through code execution, which did not supply the required file-tool discovery receipts. The draft remained diagnostic and was excluded from accepted synthesis coverage. The learner recorded the actual partial settlement and this failure, instead of treating dispatch as objective success.

This remaining tool/provenance mismatch prevents a claim that the original workflow now completes smoothly. A follow-up should make evidence receipts consistent across governed readers and surface unmet requirements early; arbitrary script output must not simply be treated as verified file provenance. This patch does not relax the gate to make the experiment pass.

The first updated repeat exposed a separate admission bug: a 2,009-character synthesis objective was copied into a delivery contract limited to 2,000 characters. All five steps were rejected. The foreground recovered and produced a source/test report, but no workers ran. The fix keeps the complete objective on the synthesis step and generates a short delivery-specific contract. The failed repeat remains under `prepared/after-pilot`.

The initial budget-accounting pilot also remains under `initial/after-pilot`: finalization initially used a smaller input estimate than admission, and continuation merging discarded the specific denial reason. Both were corrected and regression-tested before the final runs.

The first budget fixture attempted to narrow immutable limits after admission; it failed before worker execution. It remains under `initial/before-pilot` and is excluded from the matched task results. The corrected fixture narrows limits **before** graph admission, identically in both arms.

## Scope and reproduction

- Subject EstaCoda source: pinned baseline in both arms, separating runtime improvements from changes to what is being audited.
- Superagent: `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`.
- Harness: `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`.
- Web discovery was disabled; public upstream checkouts were supplied. This is a live-model work test using pinned source, not a test of latest-release discovery or Telegram transport.
- Limits: 45 provider iterations, 65 tool calls, 600 seconds per provider turn; ordinary durable worker limits remain unchanged. The stress fixture narrows the token ceiling to 160,000 before admission.
- Baseline and updated arms used isolated workspace/profile copies and the same prepared dependencies. Native-module prerequisites distinguish the `initial` and `prepared` experiments.
- `.env` and setup-lab canaries exist in the common fixture but were not scored as separate fault-injection tests.

`run.mjs` prepares immutable runtime copies and runs the four case prompts through real runtime entry points. It expects prepared upstream checkouts at `/private/tmp/lifecycle-superagent` and `/private/tmp/lifecycle-deepseek-harness`, pinned to the revisions above, plus the repository's installed dependencies. Review the upstream build/install scripts before preparation. Run with a configured Codex account and a **fresh** `/private/tmp/estacoda-lifecycle-live-*` root:

```sh
node --import tsx evals/results/lifecycle-live-2026-11-04/run.mjs /private/tmp/estacoda-lifecycle-live-new prepare
BENCHMARK_CASE=comparison node --import tsx evals/results/lifecycle-live-2026-11-04/run.mjs /private/tmp/estacoda-lifecycle-live-new before
BENCHMARK_CASE=comparison node --import tsx evals/results/lifecycle-live-2026-11-04/run.mjs /private/tmp/estacoda-lifecycle-live-new after
```

Replace `comparison` with `cancellation`, `budget` or `learning` for the other tasks. OAuth access is scoped to the fresh profile and removed in `finally`; refresh tokens are not copied. The collector excludes credentials and raw session databases. Its compact summaries include status, actual usage, failures, result disposition, source integrity and artifact hashes.

## Remaining limits

Retaining a failed report does not make it accepted research. Missing prerequisites and genuine failed checks can still prevent complete coverage. A synthesis worker with only result readers cannot independently verify diagnostic claims. Conservative input estimates can conclude research early. The reviewer can gather scoped evidence and propose a correction, but it cannot guarantee a useful correction or prove improved future performance.

The change preserves existing authority, cancellation, ownership fences, irreversible-effect handling, promotion policy, snapshots and undo. No budget was raised to obtain these results.

## Validation

- Node `v24.14.1`, pnpm `10.33.0`.
- Frozen dependency install passed using the existing pnpm store; no lockfile change.
- Typecheck, build, source smoke, distribution smoke, runtime-import audit and ESM audit passed.
- Final full suite: **787 files and 13,519 tests passed; one file/test failed**. `src/control-service/evolution-toolchain.test.ts` fails its installed-pnpm assertion on the unchanged baseline too. It is retained as a known validation limitation, not reported as a green suite.
- Targeted learning/runtime wiring: 105 passed; provider-reservation tests: 23 passed; delegation/admission tests: 38 passed.
- The first constrained full-suite run also hit local-socket permission errors. The final full suite ran with the socket access required by these integration tests; those errors disappeared.
- `validation/` contains redacted output excerpts and SHA-256 hashes of the complete local logs. The live evidence includes failed pilots, not just successful runs.
