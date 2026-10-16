# Workflow completion and recovery follow-up

This focused change addresses the product failures found in the additional 30-workflow run. It does not change Jev scoring thresholds or provider configuration.

## Changes

- General file edits use the existing digest-backed write/readback verifier, scoped to the same known turn. This covers JSON/config edits and contextual follow-ups after restart. A multi-file patch needs readback of each output. Missing, ranged, mismatched, stale, or unauthorized observations do not verify a write.
- Replacement-mode `file.patch` now supplies the content digest that other write modes already supply. Live testing exposed this second cause of the incorrect config-edit status; the regression test executes real file tools.
- Supplied prose rewrites and Arabic message drafts do not acquire execution obligations from incidental capability words. Separately requested file operations still require execution evidence.
- New extracted page text counts as progress during research completion repair. Reused reads, identical evidence, and additional search URLs alone do not reset an unchanged repair.
- Research stopped by either repeated source failures or no progress can make one tool-free partial-results continuation within existing iteration/time limits. Later stalled file delivery does not qualify. Actual authorization denials prevent this path. Incomplete evidence and file requirements remain incomplete. The explanation appears once.
- The prompt distinguishes the preliminary routing assessment from actual tool authorization, avoiding a blanket “deny” interpretation for a network-only worker. Execution policy and durable Task authority remain enforced.
- File tools read ordinary TSV and log text while retaining binary detection and workspace/path restrictions.

## Live verification

The final compiled runtime was tested through the real runtime, providers, file tools, and Task scheduler in fresh synthetic workspaces. Conversation model: GPT-6.1-sol; routing: the selected Jev-assisted configuration. Both runners verified that profile configuration remained unchanged.

| Workflow | Final outcome |
| --- | --- |
| Invoice arithmetic → verified JSON | Passed, completed |
| TSV aggregation → JSON | Passed, completed; no terminal fallback |
| Log timeline → Markdown | Passed, completed; no terminal fallback |
| Arabic message draft, no tools | Passed, completed |
| Supplied release-copy rewrite, no tools | Passed, completed |
| Targeted JSON config edit and readback | Passed, completed |
| Restart, contextual plan edit and readback | Passed, completed |
| Two research workers → synthesis → verified report | Passed; both workers, synthesis, and delivery completed; 520-word report |
| Five unavailable references, no alternative search/file | Passed; honest blocked outcome with one useful explanation and no invented policy |

**9/9 targeted live workflows passed.** This is a targeted rerun, not another complete 30-case survey. The first patch iteration still misclassified the two replacement edits; those failed runs were retained, diagnosed, fixed, and rerun. The structured evidence records both iterations and the final source-patch digest: [results](../../evals/results/workflow-completion-recovery-2026-10-16.json).

## Validation

- Node v24.14.1 and pnpm 10.33.0; `pnpm install --frozen-lockfile` passed in the clean validation checkout.
- `pnpm run typecheck` and `pnpm run build` passed.
- Final `pnpm run test --maxWorkers=2`: **12,540 passed across 764 files** (260 seconds).
- `pnpm run smoke`, `pnpm run smoke:dist`, `pnpm run audit:runtime-imports`, and `pnpm run audit:esm` passed.
- `git diff --check` passed.

An initial sandboxed suite encountered localhost/socket permission failures. A later four-worker run overlapped other validation and timed out in two five-second research acceptance tests. With no source/test-timeout changes, both passed at roughly one second in the final quieter full-suite run. The clean checkout isolates this patch from unrelated workspace changes and duplicate untracked source files.

## Review and limitations

Review covered receipt ownership, complete readback, later-write invalidation, mixed prose/action requests, denied actions, tool-free finalization, iteration/time bounds, and incomplete report status. No policy, approval, source-grounding, provider-spend, or workspace boundary was relaxed. There are no new dependencies.

The earlier SQLite source-access timeout remains an external availability limitation; this change improves the honest response to unavailable sources rather than claiming that network access is guaranteed. The installed Desktop app and gateway were not updated in this change. The live evidence here is from the compiled runtime, not a rebuilt Desktop UI/package test. Unrelated working-tree changes were excluded.
