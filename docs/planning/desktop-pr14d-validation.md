# Desktop PR14D validation

Date: 2026-09-13. Platform: macOS 26.5.2 / Apple Silicon. Node 24.14.1; pnpm 10.33.0.

## Scope and method

PR14D uses nine commits based on `4c2178cf` on `ame/desktop-foundation`. Each implementation slice received a focused review and relevant checks before commit. Source changes were checked against the PR14D sequence, selected-profile ownership decisions, and approved visual contract.

Core-wide validation ran in `/tmp/ec14c-validation`, the existing isolated tracked-source validation copy synchronized with PR14D files. Its historical directory name does not identify the milestone being tested. This excludes the pre-existing untracked duplicate source files that make typechecking the original working directory unreliable. Desktop checks ran in the original workspace. Existing planning edits and unrelated untracked files were preserved and excluded from these commits.

## Results

| Check | Result |
| --- | --- |
| `node --version`, `pnpm --version` | Versions recorded above |
| `pnpm install --frozen-lockfile` | Passed in isolated copy; no dependency or lockfile change |
| `pnpm run typecheck` | Passed; repeated after final shared gate-timeout change |
| `pnpm run test --maxWorkers=4` | 11,594 tests passed across 709 files |
| `pnpm run smoke` | All source smoke cases passed |
| `pnpm run build` | Passed; repeated after final gate-timeout change |
| `pnpm run audit:runtime-imports` | Passed, including rebuilt artifacts |
| `pnpm run audit:esm` | Passed, including rebuilt artifacts |
| `pnpm run smoke:dist` | All distribution smoke cases passed |
| `pnpm run desktop:foundation:check` | Protocol types, Desktop types, and import boundary passed |
| `pnpm run desktop:test` | 95 tests passed across 23 files |
| `pnpm --filter @estacoda/desktop exec playwright test --config playwright.config.ts` | 224 browser/visual tests passed |
| Final focused Library/Evolution browser journeys | Four English/Arabic tests passed after compact-layout, Escape/focus, and manifest-state refinements |
| Final shared gate-runner/owned-process checks | 15 tests passed after timeout alignment |
| `git diff --check` | Passed before each commit |

The full core and browser totals preceded the final narrow timeout and UI refinements. Those refinements received the repeated checks identified above; the totals are not presented as a second full-suite run of the final tree.

An earlier broad browser run passed 223/224 with an Arabic model-dialog focus failure. The focused Models/Library/Evolution rerun passed 12/12, and the subsequent complete run passed 224/224 without changing the model dialog. An initial sandboxed Desktop unit run could not inspect native PTY processes; rerunning with normal process access passed. Malformed new test fixtures were corrected to valid skill metadata before acceptance.

## Behavioral evidence

- Selected-profile memory and skill precedence; foreign Session source links rejected; linked skills, memory, usage, and Evolution files rejected.
- Worst-case Unicode/JSON escaping fits the transport frame and paged results retain every row.
- Explicit approval before promotion, cancelled reviews, stale decision authority, changed skill inputs, unsupported and truncated command gates, and durable receipt inspection without replay.
- Real project gate execution using a temporary trusted canonical workspace and `pnpm run test`: failure preserves proposed state and original skill content; successful test/approval/promotion and rollback advance the existing manifest lifecycle.
- Real owned processes stop on failure, output overflow, and abort; shared gate policy tests retain timeout/command behavior.
- Rollback restores only the latest unchanged skill file, preserves other assets, refuses pinned skills and later edits, rejects linked snapshot destinations, reports missing snapshots truthfully, and retains receipts across owner recreation.
- English/Arabic review and confirmation, failing-gate blocking, uncertain-outcome inspection, Escape cancellation/focus restoration, narrow-width containment, literal text rendering, and clearing previews on profile change/disconnect.

Risk note: these endpoints expose private profile content and can mutate skills or run explicitly reviewed project commands. Their controls preserve selected-profile scope, Main-owned confirmation, workspace trust, existing process ownership, bounded previews, and durable uncertain outcomes. The profile write lock does not serialize every external CLI/runtime writer.

## Limits of this evidence

This pass did not repeat packaged-app/native release acceptance, clean-account onboarding, paid-provider tests, or prolonged production usage. The browser interactions use isolated semantic API fixtures; core ownership tests separately exercise actual state stores, filesystem changes, native processes, and canonical workspace leases. No result here changes the existing fact that skill metadata evals are not real task-fixture execution.

Release signing/notarization and production reliability remain their existing release/operational gates. The [behavior document](desktop-pr14d-library.md) records the supported restoration and uncertain-receipt limits rather than implying generic undo or automatic recovery.

## Review follow-up

The subsequent [focused PR14 reliability fix](desktop-pr14-review-fixes.md) records corrections for transport acceptance, stale-review recovery, read-only usage inspection, Settings cancellation, and growing Evolution histories, with fresh validation results.
