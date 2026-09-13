# Desktop PR15 scheduling acceptance and ownership

Implemented on `ame/desktop-foundation`, 2026-09-13. This record closes the scheduling dependency in the PR14B inventory. It does not close PR14B's other limits or PR16's packaged-release gate.

## Delivered behavior

The approved status-strip scheduling entry opens Background work. Its live Schedules section reads the selected profile's core Cron store. It provides paginated schedules, execution history, delivery outcomes, failure categories and links to attributable source Work. Disconnected state is unavailable; queued manual requests are not presented as running. Paused and completed schedules do not advertise an automatic next run.

Create, edit, delete, enable, disable and Run now require review and explicit confirmation. The editor supports once, interval and five-field Cron schedules, objectives, canonical targets, model overrides, delivery, skills, toolset restrictions, context schedule IDs, repeat limits and the existing script/arguments/timeout/no-agent fields. Cron expressions use the core UTC parser; ISO timestamps should include their timezone. Script paths and arguments remain existing core Cron inputs, not a new Desktop command executor.

Review identifies the selected profile, canonical workspace, model, approval mode, profile session spending ceiling, delivery and next run where applicable. It explains failure behavior and manual-run semantics. No per-schedule lifetime budget is invented. Model/provider defaults are resolved again at execution. Explicit toolset restrictions are retained; actual tool availability still depends on the runtime registry and configured capabilities. Cron's forced-disabled toolsets remain prohibited.

English and Arabic labels, validation, review, history and action states use the existing catalog. Technical values are isolated from bidirectional prose; user objectives retain automatic direction. The editor preserves multiline arguments, supports Escape cancellation and restores focus to its initiating control. Existing approved visual fixtures remain unchanged.

## Authority and execution ownership

- Core `CronStore` remains the profile-local persistence writer; core `tickCron`, runner, lock and gateway lifetime remain the scheduler. Electron neither ticks schedules nor launches a parallel scheduler.
- Saving a local schedule binds its profile and canonical execution-target identity/generation. Runtime checks that binding, trust and currently enabled delivery channels before execution; runtime dispatch hooks and delivery also recheck authority. Channel-origin schedules retain their original principal and target and cannot expand their delivery scope through this editor.
- Review is bounded, expires after five minutes and is invalidated by relevant definition/configuration/target changes. Main binds reviews to the current connection generation. Confirmation uses durable reference-only operation receipts; an unknown or uncertain result is inspected rather than replayed.
- Run now queues a request. The runtime must be available and awake to execute it. A manual run of a paused recurring schedule preserves its pause. Existing core behavior may reactivate a completed schedule when a manual run is requested. Disable clears queued manual requests and prevents future automatic runs; disable/delete do not cancel an execution that has already started.
- Recurring failures are recorded and advance to the next normal run; Desktop adds no retry policy. Once or exhausted schedules complete according to the existing Cron owner.
- Execution records carry nullable profile attribution, including failures before a Session exists. Legacy records are visible only when an owned Session establishes their profile. Job ID matching alone never grants access to history. History excludes raw outputs and failure messages; retained source Work is the separate content surface.

## Compatibility and practical limits

Existing CLI definitions remain readable and editable without a second store. A legacy unbound schedule must first be edited, assigned a trusted target and confirmed before Desktop can enable it or request a manual run. CLI read/edit/pause and Desktop refresh round-trip the same definition; existing channel origin is preserved. Unsupported or oversized editable definitions are blocked without truncating and overwriting the original.

Schedule reads are bounded to 1 MiB / 1,000 stored definitions; list pages use the existing bounded projection helper, and history pages contain at most 50 records. Historical runs with no provable profile are deliberately omitted. Missing history is shown as unavailable, not as evidence that nothing ran.

Creating a schedule does not install/start a gateway service or prevent sleep. Closing Desktop does not stop an independently running shared runtime. Network delivery, provider calls, script execution and spending still depend on current runtime configuration and authorization. This milestone does not add cloud hosting, future agent/deployment ownership fields, a wake-from-sleep guarantee, or a delivery retry queue.

## Validation record

Checks ran on macOS with Node 24.14.1 and pnpm 10.33.0. Core checks used a clean validation copy containing the branch's tracked implementation plus current PR15 changes, because the working directory contains pre-existing untracked duplicate source files (including `src/types/bidi-js.d 2.ts`) that otherwise break typechecking. Those files and unrelated planning edits were preserved.

- Focused schedule/control/Cron tests cover owned history, early failures, linked-state rejection, review/cancel/confirm, stale configuration and CLI edits, target/profile/trust revocation, delivery/model binding, channel-origin restrictions, durable operation deduplication, and paused manual-run semantics.
- CLI parity uses the actual `runCronCommand` with all three schedule forms and preserves context, skills, repeat limits, script arguments and timeout across Desktop edits.
- Six scheduling browser journeys cover English/Arabic creation/edit/delete/cancel, all schedule forms, argument preservation, review-before-write, focus restoration, redacted errors, source Work and disconnected state. These use controlled API fixtures; they do not claim live provider or remote-channel delivery.
- Desktop protocol/type boundary checks passed; all 95 Desktop unit tests and all 230 browser acceptance tests passed, including existing visual fixtures.
- Full core suite: 715 files, 11,622 tests passed. The final paused next-run projection correction additionally passed its focused regression tests.

`pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run smoke`, `pnpm run build`, `pnpm run audit:runtime-imports`, `pnpm run audit:esm`, `pnpm run smoke:dist` and `git diff --check` passed. The final projection fix was synchronized before the successful build and distribution smoke checks. Native packaged distribution, signed/notarized installation, real-provider/channel schedule runs and extended sleep/restart reliability remain separate acceptance work; the browser and unit results are not a substitute for those checks.
