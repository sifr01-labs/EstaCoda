# Research recovery and conversational completion — 2026-10-16

This patch addresses the three failure mechanisms reproduced against `8107e25d`: false execution requirements for supplied-code/hypothetical questions, a newly introduced passage-search recovery regression, and an unhelpful stop after repeated network-read failures.

## Behavior

- Completion classification removes informational clauses before matching execution surfaces. Supplied snippets and hypothetical future requests no longer acquire read/write obligations from incidental tool names. Separately requested reads, edits and file outputs retain their obligations.
- Web extraction identifies a literal-query miss or an out-of-range offset explicitly. Task acceptance can reconcile that miss with a later authorized, nonempty extraction of the same source. Actual extraction failures retain their original reason. Existing source evidence checks still apply.
- The repeated-failure threshold still stops network work. A research turn may use one tool-free continuation, within remaining iteration/time limits, to explain partial observations, limitations and next steps. A deterministic explanation remains if continuation is unavailable. Denied actions prevent this continuation. Any provider-requested tools during finalization are never executed. Citations to unobserved sources prevent inclusion of the optional model summary; the deterministic explanation remains.
- Incomplete research remains incomplete. Missing file execution evidence is still reported; a partial explanation is not a saved or verified report.

## Review and risk

This touches completion classification, tool-result metadata and task acceptance. It changes no trust, approval, URL access, credential, profile, spending or tool-execution permissions. The new recovery exception requires the same source, a later successful nonempty read, and allowed decisions. Negative tests cover denied reads, another source, empty recovery and unrecovered misses. Finalization tests cover exhausted iteration/time limits, cancellation, provider failure and hallucinated tool calls.

Review caught a classification change affecting multi-sentence edit requests. The patch was narrowed to preserve existing clause boundaries, then the workspace copy/review integration tests were rerun successfully. The previously failing task-executor acceptance case now passes with real extraction handlers and controlled source content.

## Validation

Validation uses a clean archive of `8107e25d` with only this patch overlaid. The working tree contains unrelated changes and duplicate source files; those are excluded from this commit and the test package.

- Locked dependency installation, type checking, build, runtime-import audit, ESM audit, source smoke and distribution smoke checks passed.
- The final provider-loop and research acceptance suites passed all 214 tests, including partial-result delivery and citation provenance.
- Completion/interpretation checks passed 103 tests; the existing workspace copy/review integration suite passed all 15.
- Five suites with load-related timeouts passed all 688 tests when rerun with two workers. A subsequent full default-concurrency run passed 12,522 tests with one unrelated CLI entrypoint timeout. The final four-worker run passed all **12,523 tests across 764 files** in 153.46 seconds. No tests were disabled and no timeout limits were increased.
- Six additional assertions run directly from the packaged runtime passed: the three original informational prompts, an actual save request, and both passage-navigation failure reasons. No external calls were made.
- Desktop packaging and package verification passed: runtime inventory, native SQLite/image/PTY dependencies, CSP, fuses, signature verification and relocated hardened-app startup with its owned Node bridge.

The package runtime digest is `5e22bb1e3d648579d27ccb4998872d452ff81282ab2495f4db8013bf641fee90`. The temporary validation archive has no Git identity; this digest identifies the built bytes. This is a validation package, not an installation update.

Live workflow testing against configured providers was blocked by automatic approval review over external transfer of test prompts and normal profile context. Approval has been requested. No new live success rate is claimed. The deterministic acceptance tests exercise real tool handlers with controlled source content and the real worker acceptance path; they do not establish external-provider reliability.

The installed app and gateway were not replaced. The prepared package is at `/tmp/estacoda-recovery-validation/apps/desktop/out/EstaCoda-darwin-arm64/EstaCoda.app`.
