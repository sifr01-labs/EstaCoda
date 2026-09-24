# Capability recovery implementation — PR 3

Implemented on the existing `ame/reliability-baseline` branch. This record covers transient capability recovery; it does not claim completion of PR 4–6 or rebuilt desktop acceptance.

## Commit structure

1. `feat(tools): add bounded capability discovery and exposure requests` — session-filtered metadata search and exact-ID requests, bounded pending state, authenticated execution receipts, revision/availability checks, and session provider registration.
2. `feat(runtime): apply capability expansion between provider iterations` — request-driven schema expansion after the full tool batch, stable aliases and budgets, recovery feedback and diagnostics, duplicate/no-progress handling, and real-runtime fallback/approval tests.
3. `feat(skills): load recovered skill instructions with execution receipts` — reuse `skill.read` content/readiness contracts; deliver bounded continuation context; record authenticated `loadedSkills` independently of routing matches; verify confirmation, cancellation, setup, and stale-definition boundaries.

## Implemented boundary

- Discovery returns at most eight metadata entries from the final session catalog and visible skill registry. Unknown and excluded IDs have the same response.
- Requests carry at most eight exact IDs and a reason of at most 300 characters. Runtime-owned receipts authenticate the actual successful handler result, call identity, profile, session, and turn. Provider prose and copied result metadata cannot produce receipts.
- Expansion occurs only after the current batch settles and before a subsequent provider iteration. Same-batch calls cannot use newly requested tools. At most two successful request rounds and eight additions per round are allowed, without evicting active schemas or exceeding 100 schemas / 24,000 estimated schema tokens. Browser-vision recovery shares the addition and total-schema ceilings.
- Current registration identity, execution handler, definition, and availability are checked again. Native aliases and history continue through the existing provider executor and fallback path.
- Requesting a skill exposes `skill.read`; it does not execute its playbook or activate toolsets. Explicit-confirmation skills return a blocker. Missing setup is reported using existing readiness metadata and does not trigger installation/configuration changes.
- Successful root instruction/contract reads are retained as explicit continuation content, bounded to 32,000 characters across recovered skills per turn. Metadata-only/resource reads and truncated full reads do not qualify. Delivery receipts are emitted only after a subsequent successful provider dispatch receives this context. Cancellation before that dispatch records no loaded skill.
- Recovery operations and target tools retain normal executor approvals, workspace trust, hardline checks, and profile/child scoping. Exposure grants no authority. All recovery state is transient and cleared at turn end.

## Review and risk

This is a security-sensitive tool-exposure change. Focused review checked that final session filtering precedes catalog binding, that native admission uses the current iteration's exact schemas, and that successful recovery cannot approve the target action. Strict-policy integration coverage approves the metadata request and independently denies the requested file write. No security policy, install path, grant store, or global registry was widened.

The runtime registration expectations were intentionally updated for the two new read-only-local session tools; snapshot changes were reviewed for unrelated churn. Existing unrelated planning edits and untracked duplicate source files were preserved.

## Validation

The working tree contains an unrelated untracked `src/types/bidi-js.d 2.ts` duplicating three declarations. Ordinary TypeScript commands include it; isolated tracked-source checks use temporary configurations outside the repository and do not alter project configuration or remove that file.

| Check | Result |
| --- | --- |
| Node / pnpm | v24.14.1 / 10.33.0 |
| `pnpm install --frozen-lockfile` | Passed; lockfile unchanged |
| `pnpm run test` | Passed: 11,886 tests across 740 files |
| Focused runtime/tool/prompt/acceptance checks | Passed: 344 tests across nine files before final additions; all additions passed in the final full suite |
| `pnpm run typecheck` | Blocked by three duplicate identifiers in the unrelated file above |
| `pnpm run build` | Blocked by the same duplicate declarations |
| Tracked-source typecheck and build | Passed using temporary configs extending the repository configs |
| `pnpm run audit:runtime-imports` / `pnpm run audit:esm` | Passed; ESM audit used the tracked-source build |
| `pnpm run smoke` / `pnpm run smoke:dist` | Each passed 12/13; Evolution lifecycle failed because its gate invokes the ordinary typecheck |
| `git diff --check` | Passed |

An earlier full-suite run exposed the registration expectation update; that was corrected. Another run encountered a 15-second CLI entrypoint timeout during concurrent validation. The file passed independently (three tests), and the final full suite passed without concurrent builds/smoke jobs. No timeout or security assertion was weakened.

Rebuilt desktop acceptance, held-out routing gates, persistent requirement continuity, and multi-worker research settlement remain in the later planned slices.
