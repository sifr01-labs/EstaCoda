# PR 0 implementation record

Branch: `ame/reliability-baseline`, based on `ame/desktop-foundation`.
Base commit: `2ec3daa66fa35291c3b6d92b7d2ed5b1350eab30`.

This series establishes a baseline; it does not fix routing or enable Jev.
Known-gap assertions intentionally pass on current behavior. Replace them with
desired-behavior assertions in the owning implementation PR, rather than skipping
them or treating baseline success as product acceptance.

## Commit 1 — Routing and completion characterization

`src/runtime/research-routing.characterization.test.ts` loads the two real bundled
research skills through the source loader and executes the source router, tool
selection, schema catalog, and outcome functions. Its six-tool catalog is a
controlled inventory, not a claim about the full runtime inventory.

The synthetic requests reproduce missed delegation, generic skill recovery,
noncontiguous paper discovery, English file completion without a write, Arabic
classification/exposure gaps, and pre-selection catalog truncation. Healthy
controls cover exact/slash skill selection, greeting, documentation writing and
negated saving. These tests contain no private conversation transcript or live
profile state.

Validation: frozen-lockfile install; 172 tests passed across the new
characterization and router, narrowing, policy, and outcome suites; diff check.
Typecheck is blocked by pre-existing duplicate declarations in the untracked
`src/types/bidi-js.d 2.ts`; these unrelated files are preserved. The initial check
also caught missing fields in the new provider fixture, corrected before finalizing
this commit.
Review: no runtime behavior changed; source behavior agrees with the previously
observed failure shapes. The catalog-cap reproduction establishes a separate
defect, not proof that the original conversation hit that cap.

Security risk: test-only changes. Real execution and policy boundaries remain
unchanged. End-to-end provider/Task evidence belongs to the next harness slice.

## Commit 2 — Deterministic workflow harness

`src/runtime/research-request.acceptance.test.ts` uses
`src/test/fakes/research-workflow-harness.ts` to exercise `createRuntime`, real
bundled skills, native provider call parsing/planning, tool execution, event
receipts, workspace file tools, SQLite Task storage, the scheduler, child agent
loops, and Task result reading. Provider answers and web content are scripted;
successful work is established separately from receipts, stored results and
file contents. Each harness has a disposable workspace and profile home. Any
unexpected global fetch or unscripted provider request fails the test.

Six scenarios cover the three-turn failure chain (A1–A3), native write/readback,
denied write, three admitted research workers plus synthesis and subsequent file
delivery, missing search at delegation admission (A9), and duplicate successful
extraction (A12). The positive delegation control uses an explicit `/researcher`
route and recognized write wording: it demonstrates functioning execution seams,
not that the failing natural-language workflow has been fixed. Child runs are
serialized for deterministic scripting; this is not a concurrency benchmark.

The harness inspects the delivered selected skill content (full body or existing
bounded contract), tool inventory/schema estimates, stable call IDs, successful
execution receipts, distinct worker sessions/results, synthesis dependencies,
and output bytes. It does not invent requirement state or detailed omission
reasons that current production telemetry does not yet provide. Those remain
PR 1/2/4 work. Policy denial uses a deterministic injected policy; it does not
replace the later strict/adaptive/open conformance matrix.

Validation: 79 tests passed across both new suites and durable delegation,
agent-step execution and Task-result tools. Typecheck reports only the existing
untracked duplicate bidi declarations. Review found and corrected a fixture
argument-name mismatch; Task result reads now use the real `task_id`/`result_id`
schema. No runtime policy or production execution behavior changed.

## Commit 3 — Executed routing and exposure measurements

The existing `routing-evolution-baseline` eval now also runs 18 development
probes against the actual bundled research skills, router, narrowing and outcome
functions. The new `research-capability-baseline.ts` report keeps their measured
results separate from the older synthetic metric seeds. Expected skill/tool
labels are authored independently; missed selections stay in the denominator.
The scope is two real skills and seven controlled tool definitions, not the full
skill catalog. This corpus is not the future held-out PR 6 release corpus.

Recorded results: [research-reliability-v1.json](../../evals/baselines/research-reliability-v1.json).

| Development measurement | Result |
|---|---|
| Primary-skill precision | 3 / 3 |
| Primary-skill recall | 3 / 8 |
| Required-capability exposure recall | 14 / 22 |
| Task-class accuracy | 8 / 18 |
| Unwanted exposures in negative controls | 0 |
| Counterfactual no-execution probes falsely marked complete | 6 / 9 |

The report includes per-language denominators (13 English, 3 Arabic, 2 mixed).
Precision is `null` when there are no selections, rather than invented perfect
precision. Counterfactual completion probes are not live-model failure rates.

The accompanying measurement script also executes the three-turn runtime harness
with real schemas: five provider calls, tool-call counts `[2, 0, 0]`, zero Tasks,
no report file, and all three outcomes marked completed. Initial schema estimates
are 1002, 1002 and 790 tokens (median/p95 1002). These are rough runtime estimates
for this fixture, not tokenizer measurements or a justified global schema ceiling.
PR 2/3 must measure broader inventories before choosing that ceiling.

Reproduce without network, credentials or private profile data:

```bash
pnpm run eval:fixtures -- routing-evolution-baseline
node --import tsx scripts/measure-research-reliability-baseline.ts
```

To intentionally refresh the recorded artifact, redirect the second command to
`evals/baselines/research-reliability-v1.json` and review the changed measurements.
The script emits only fixture observations, never provider prompts or local paths.

## Validation and remaining boundaries

- Node v24.14.1 and pnpm 10.33.0; frozen-lockfile install succeeded unchanged.
- Both routing eval suites: 14 tests passed; the existing eval CLI passed.
- Full `pnpm run test`: 11,743 tests across 736 files passed after allowing local
  IPC/loopback access. The initial sandbox run had 11 socket-related failures and
  one associated unhandled socket error; no PR 0 tests failed in that run.
- `pnpm run audit:runtime-imports` and `git diff --check` passed.
- Standard `pnpm run typecheck` and `pnpm run build` are blocked by three duplicate
  identifier errors from the pre-existing untracked `src/types/bidi-js.d 2.ts`.
  No unrelated duplicate files were removed or edited.
- A temporary TypeScript configuration selecting tracked source plus the new
  PR 0 files passed typecheck (including the measurement script), and a matching
  tracked-source build succeeded. These checks excluded unrelated untracked
  source duplicates and did not change repository compiler configuration.
- `pnpm run audit:esm` passed against that compiled output. This is not a claim
  that the standard unfiltered workspace build passed.
- Source smoke: 12 / 13 passed; the Evolution lifecycle case invokes the ordinary
  workspace typecheck and fails on the same duplicate declarations.
- Compiled smoke: 12 / 13 passed against the tracked-source build; the same
  Evolution case fails on its source typecheck gate. The initial compiled checks
  could not run after the standard build failed and cleaned `dist`; the successful
  tracked-source build supplied the output used for these final compiled checks.

Review of commit 3: verified labels and metric denominators, nullable precision,
source-relative skill loading in both source and compiled layouts, fixture-only
output, and cleanup. No live providers or paid calls were used. The remaining
workspace validation blockers are independent of the committed changes.

This PR is a baseline, not release acceptance. It does not deliver the natural
language routing fixes, capability recovery, persisted requirements, live-model
quality measurement, Jev integration, or Desktop/Telegram packaged acceptance.
Known-gap assertions must be migrated with the relevant PR 1–5 fixes. Security
review: production changes are confined to offline eval measurement; runtime
authorization and tool behavior are untouched.
