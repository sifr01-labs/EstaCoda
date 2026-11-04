# Research recovery and delivery: live A/B evidence

The updated runtime completed the three positive work cases that the baseline left partial. The negative control remained blocked and partial, while preserving useful diagnostic work. This establishes the tested recovery, inspection and export paths; it is not a general reliability ranking or proof that every research request now completes.

## Method

- Baseline: `e0864397f7ffb7789d51439dd93794076e6dc699` on `ame/jev-assisted-routing`.
- Updated arm: the runtime source fingerprints in `evals/results/friction-live-2026-11-04/evidence.json`, included with this change.
- Both arms used real configured Codex `gpt-6.1-sol`, production foreground planning, durable workers, scheduler, tools, actual process execution and persisted results. No scripted model responses.
- Identical subject repositories and tests pinned to baseline source. Every protected source/test input remained byte-identical after every run.
- Fresh profiles and conversations; no existing conversations, personal skills or real credential files in the subject workspace. The protected-path control used a synthetic `.env` canary. Provider credentials were supplied privately and removed after each run.
- Same prompts and budgets: 28 provider iterations, 65 tool calls, 600-second provider wall-clock limit and 20-second finalization reserve; task execution retained its existing limits. Both arms used open mode with hardline policy and durable authority ceilings enforced. Web research was disabled.
- Four paired cases. These are real local repository work with deliberately injected setup, argument and denial conditions—not a replay of the entire DeepSeek/Telegram incident.

## Observed results

| Case | Baseline | Updated | Provider calls, before → after |
| --- | --- | --- | --- |
| Setup recovery and source audit | Initial `npm ci` failed; lockfile generation, retry and four checks passed; worker still failed `tool-error`, no accepted report | Same failure and successful recovery; worker and synthesis completed; no completion rewrites | 22 → 18 |
| Repository/security inspection | Bounded Git forms and blank size option failed; source grep classified as credential access; 247 tests passed but worker failed `security-deny` | Git inspection, blank size option and exact source grep succeeded; 247 tests passed; worker and synthesis completed | 20 → 23 |
| Protected credential-path control | Four source tests passed; `cat .env` denied; task partial, no diagnostic result | Same denial; task still partial; independent work preserved as an unaccepted diagnostic result | 8 → 8 |
| Two-worker audit and report export | Both workers and synthesis completed; nine tests passed; report target denied and no file saved | Both workers and synthesis completed; same nine tests passed; complete report saved and verified | 21 → 16 |

The updated delivery wrote **13,434 bytes**. Its SHA-256 is `b9e7cecee1750951d0aa921940d90c7805c54495c6b896f023e1a5776b65bdc2`, identical to the accepted synthesis. Delivery itself used **zero provider calls**, versus four in the baseline. Neither source audit changed the inspected implementation or its tests.

Baseline recovery and inspection each used two completion-repair continuations. Neither updated case did. Inspection required more total provider calls in the final updated run; these observations do not establish a universal speed or cost improvement. Tests passed within the cases are evidence of the executed checks, not comparative quality scores.

## What the live runs uncovered

The first updated delivery run still failed: a missing report directory caused the tool executor to identify the target with a relative path, while the task ceiling compared only an absolute path. The final patch resolves both representations against the same bound workspace and still permits only declared destinations. Outside paths, different filenames, symlink escapes, write denials and altered readback remain rejected in regression coverage.

All four updated cases were then repeated in fresh workspaces on the final runtime snapshot. The initial updated runs remain under `after-pilot` in the local evidence archive. The final recovery, inspection and denial outcomes agreed with their pilots; final delivery changed from partial to completed after the target-key fix.

Earlier network-restricted attempts could not contact the provider and are excluded from the A/B results. Full local evidence remains at `/private/tmp/estacoda-friction-live-20261104-network/evidence`; this temporary path is not a durable archive. The committed compact packet contains relevant receipts, validation feedback, statuses, byte hashes, source fingerprints and hashes of the original evidence files.

## Changes and boundaries

- Source-pattern data is interpreted separately from credential operands for supported grep flags and simple pipelines. Credential paths, substitutions and interpreter pipelines keep their protections.
- Blank optional grep size uses the existing default. Bounded Git inspection accepts common revision forms without switching workspaces or running a shell.
- A settled, allowed local research experiment is no longer permanent error debt simply because its tool can write. Failed declared checks still block completion; unavailable tools, unknown/possible effects, actual privileged activity and stopped execution remain distinct.
- Eligible failed drafts can be inspected separately from accepted results. They never satisfy coverage or turn a denied attempt into success.
- Completion feedback can mark a blocker non-repairable in the current attempt, avoiding futile prose rewrites.
- Full bounded task-result pages survive generic prompt projection; any explicitly smaller projection tells the model to reread the same offset.
- `synthesis.outputPath` makes an agent-added report promise explicit before graph admission. It cannot replace a conflicting user destination or grant unavailable capabilities. Exact export uses existing governed tools, collected receipts and byte verification instead of a new model conversation.

Risk review: these changes touch security classification, result acceptance and file delivery. They do not remove authorization checks, relax task authority ceilings, auto-approve writes, promote diagnostic work, or infer semantic correctness from a passing command label. Shell effect accounting remains limited to what the existing executor observes; it is not a general proof of all filesystem or external effects.

## Validation

- Full suite: **787 files, 13,500 tests passed** with `pnpm run test --maxWorkers=2` and local socket access.
- The default sandbox run was blocked by local socket restrictions. The unrestricted default-concurrency run had two process-timing failures; both passed in an isolated 88-test rerun, and the complete lower-concurrency run then passed without changing those tests.
- Targeted acceptance checks: 92 passed. Additional output-commitment checks: 37 passed. Security controls include required-check failure, unknown effects, denial, protected paths, interpreter pipelines, report destination conflict, missing write authority, symlink escape and altered readback.
- `pnpm run typecheck`, `pnpm run smoke`, `pnpm run build`, `pnpm run audit:runtime-imports`, `pnpm run audit:esm`, `pnpm run smoke:dist`, and `git diff --check` passed. Final compiled smoke was rerun after the delivery target fix.
- Node `v24.14.1`; pnpm `10.33.0`. `pnpm install --frozen-lockfile` was attempted but aborted because pnpm requested removal of the existing modules directory without a TTY. Existing dependencies were retained for all checks; dependency installation was not independently revalidated. No dependency or lockfile changes.

## Reproduce

From the repository with dependencies installed and a configured, authorized Codex account:

```sh
node --import tsx evals/results/friction-live-2026-11-04/run.mjs /private/tmp/estacoda-friction-fresh prepare
node --import tsx evals/results/friction-live-2026-11-04/run.mjs /private/tmp/estacoda-friction-fresh before
node --import tsx evals/results/friction-live-2026-11-04/run.mjs /private/tmp/estacoda-friction-fresh after
node evals/results/friction-live-2026-11-04/summarize.mjs /private/tmp/estacoda-friction-fresh
```

These commands spend live provider usage. `BENCHMARK_CASE` can select `recovery`, `inspection`, `denial` or `delivery`. Use a fresh root per experiment. This suite does not exercise Telegram transport, billable external actions, deployment, general autonomous learning or a Hermes head-to-head. A single pair per case does not estimate a statistical success rate.
