# Governed delegated execution and skill discovery: live A/B validation

The updated runtime completed a real repository review that the previous build left partial. Its foreground model created two durable workers, both workers executed their focused tests, and synthesis read both accepted reports. A separate skill-discovery session returned the visible catalog and delivered an answer instead of repeating lookups until the loop guard stopped it.

This proves these paths in the recorded runs. It does not establish general autonomous reliability, a performance ranking against Hermes, or successful Telegram delivery. No UI changes are included.

## Focused implementation

- Default delegated access now inherits eligible parent-visible workspace execution and editing tools. Explicit operator restrictions, parent visibility, tool/toolset intersections, workspace trust, normal command approval, Task authority, hardline denies and delegation-depth limits remain effective. Shared process management, memory/skill mutation, configuration, scheduling, credentials and external-effect classes are not granted by this change.
- The existing `delegate_task` tool offers `mode=inspect`, with no task creation or authority grant. Admission errors return eligible alternatives. Creation and dispatch revalidate access. Descriptions explain that required tests belong in worker objectives, or must finish in the parent before durable handoff ends its turn.
- An explicit repository-research worker contract suffices for the existing local-read limitation rule. The parent intent classifier need not independently classify the request as research. Successful observed repository evidence and citations are still required. Denials, missing capabilities, uncertain effects and failed execution remain outside that exception.
- `skill.list` treats blank/whitespace category as no filter, reports both match count and visible total, and distinguishes an unmatched category from an empty visible catalog. It uses the session-visible registry and does not disclose hidden skills/categories.
- Native history keeps actual current-turn execution receipts current across continuation batches. Older-turn observations retain historical labels, and missing results remain unavailable. Labeling newly obtained evidence as stale was encouraging repeated lookups.

## Matched live experiment

Baseline: `fbf1f4db2e190009e217beb9989d6f239568330f` on `ame/jev-assisted-routing`.

Both arms used Codex `gpt-6.1-sol`, no fallback, identical prompts and budgets, fresh isolated profiles/sessions, and identical source inputs. The subject was the updated EstaCoda source snapshot in both arms, isolating runtime behavior from differences in the reviewed code. The fixture has its own Git revision, recorded in the manifest; it is not the upstream branch revision. The final production-source hashes are recorded there. A prompt regression test and a test-description correction were added afterward; neither changes production behavior.

The foreground model—not the benchmark script—chose tool arguments and created the graph through `delegate_task`. Production Task scheduling, agent-step execution, result validation and synthesis followed. Two workers reviewed real source and ran these commands:

```sh
pnpm exec vitest run --config vitest.node.config.ts src/delegation/toolset-security.test.ts src/tasks/task-approval-service.test.ts
pnpm exec vitest run --config vitest.node.config.ts src/tools/skill-tools.test.ts
```

| Observation | Previous build | Updated build |
| --- | --- | --- |
| Durable task outcome | Partial | Completed |
| Worker results | Both failed acceptance | Both accepted |
| Synthesis | Skipped | Completed; read both reports |
| Executed worker tests | None | 15 + 37 passed, both exit 0 |
| Delegation admission failures | 2 | 0 |
| Research provider calls | 54 | 41 |
| Research elapsed time | 194 seconds | 137 seconds |
| Blank-category skill listing | 0; “No skills found” | 19 visible skills |
| Missing-category probe | Not reached | 0 matches, 19 visible total |
| Skill-session outcome | Loop guard; partial | Normal completion |
| Skill provider calls | 11 | 5 |
| Source inputs unchanged | Yes | Yes |

The updated skill worker encountered a local grep error and still produced an accepted, qualified report. The final research run inherited eligible tools without a preview call; the intermediate updated run exercised `mode=inspect` successfully. Deterministic tests cover preview without task creation, revocation revalidation, explicit read-only policies, and approval allow/ask/deny preservation.

The separate skill audit deliberately requested blank, omitted and nonexistent category inputs. The provider's exposed schema required the category field, so the updated model repeated a blank field and disclosed that literal omission was not independently tested. It also tried an unavailable execution-wrapper route. Thus this run demonstrates correct listing/filter interpretation and delivery despite a failed attempt, not error-free tool use. Omitted-filter equivalence is covered by deterministic tests. The count of 19 belongs to this isolated bundled catalog; it is not a claim about the Telegram profile's 29 skills.

Elapsed times are descriptive only: one final pair, nondeterministic model behavior, and other validation running concurrently. No pricing or general efficiency claim is made.

## Earlier attempts, retained

The evidence bundle includes every pilot and intermediate arm, not only the final success.

1. The pilot updated workers could execute all 52 tests, but their reports were rejected. The fixture lacked a Git checkout, and the local-read limitation rule unnecessarily depended on the parent's research classification. Both pilot skill sessions also hit the loop guard. The fixture was corrected and the redundant classifier condition removed.
2. The intermediate updated research task completed (43 calls, 151 seconds), including all 52 tests and accepted synthesis. Skill listing returned correct data but still looped. Keeping only the latest batch current was insufficient: earlier receipts from the same turn were still labeled stale.
3. The final pair uses the corrected Git fixture and current-turn receipt handling. All eight independent receipt-grader checks pass. Failed attempts and diagnostic reports remain inspectable.

The runner exports actual calls/results, answers, validation and usage. It omits duplicate prompt/accounting projections; no failed execution or rejected report is removed from the retained evidence. Markdown copies normalize trailing spaces; transcripts retain the result text.

## Validation and limits

Final full suite: **13,483 tests passed across 786 files**. Node/pnpm version checks, frozen installation, typecheck, source smoke, build, runtime import audit, ESM audit, distribution smoke and diff checks passed. The final extra test-label edit passed its focused suite. Earlier validation attempts exposed stale expected behavior after the intended changes, plus transient subprocess/CLI timeout failures under higher concurrency; the final full suite ran with four workers and passed.

Risk: shell exposure is broad. These workers are governed by existing execution policy, not an OS sandbox or a test-only command allowlist. Existing profiles explicitly configured as read-only remain read-only. No new execution approval bypass or automatic permission grant is introduced.

The live runner used installed dependencies, but a worker's isolated HOME caused Corepack to emit an “about to download” notice. Actual package-manager downloading was not independently established. Consequently, strict zero-network/bootstrap behavior cannot be certified, although the model issued no installation command and performed no network research. Temporary credentials were removed and exported evidence scanned for credential patterns and private home paths.

The synthesized work product identifies additional skill-search completeness and integration-coverage concerns. Those findings are retained, not silently converted into unrelated fixes. The focused worker suites do not cover the whole product; broader repository validation above was run independently. Telegram routing/delivery, full DeepSeek/Harness investigation, general skill self-improvement and a live Hermes comparison remain outside this experiment.

## Evidence and reproduction

- [Receipt comparison and prior attempts](../../evals/results/delegated-work-live-2026-11-03/comparison.json)
- [Actual synthesized review](../../evals/results/delegated-work-live-2026-11-03/REPORT.md)
- [Inputs, prompts, budgets and source hashes](../../evals/results/delegated-work-live-2026-11-03/manifest.json)
- [Live runner](../../evals/results/delegated-work-live-2026-11-03/run.mjs)
- [Offline receipt grader](../../evals/results/delegated-work-live-2026-11-03/grade.py)
- [Validation record](../../evals/results/delegated-work-live-2026-11-03/validation.json)

From this repository, archive the existing adjacent evidence before rerunning. Run `node --import tsx evals/results/delegated-work-live-2026-11-03/run.mjs /private/tmp/<fresh-directory> prepare`, then the same command with `before` and `after`. The baseline revision is pinned; the updated snapshot comes from the current checkout. Model calls use the selected profile's authorized Codex credential in temporary isolated profiles. `BENCHMARK_CASE=work` or `BENCHMARK_CASE=skills` runs only that case. Finally run `python3 evals/results/delegated-work-live-2026-11-03/grade.py`; grading makes no model calls.
