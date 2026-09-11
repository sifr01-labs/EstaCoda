# Desktop PR 3 implementation record

Branch: `ame/desktop-foundation`, continuing Desktop PRs 1/2 and their review correction. Scope: private control service, authenticated supervisor readiness, bootstrap snapshots, isolated credential staging, safe state notifications and bounded replay. [Service reference](../architecture/desktop/control-service.md).

The later [PR3/PR4 correction](desktop-pr3-pr4-corrections.md) extends priority admission to execution controls.

## Eight commit slices

| Slice | Delivered and reviewed |
| --- | --- |
| 1 — Profile-bound stdio server (`ff7bc04a`) | Strict byte framing/UTF-8, negotiated handlers, fixed errors, request cancellation, output bounds and disposal. Focused transport tests and clean-copy typecheck passed before commit. |
| 2 — Existing supervisor endpoint (`8a7a9d2f`) | Authenticated read-only readiness probe, instance/version/capability checks, profile-derived discovery, no executor dispatch/startup/ownership. Existing and new socket tests plus typecheck passed. |
| 3 — Internal CLI (`60c1d30c`) | Explicit private stdio/profile command before interactive initialization. Real child-process initialization, invalid arguments, no state writes and SIGTERM checks passed with typecheck. |
| 4 — Bootstrap snapshots (`fe5306d4`) | Core-selected profile configuration, independent supervisor status, immutable cursor epochs and stale-capture invalidation. Bootstrap and real CLI tests plus typecheck passed. |
| 5 — Credential pipe (`176948aa`) | Explicit descriptor 3, in-memory candidates, scope/generation/capacity/TTL rules, fixed replies and close disposal. Real inherited-pipe and canary tests plus typecheck passed. |
| 6 — Safe runtime notifications (`e123c07b`) | Fixed status-change projections and one cancellable observer; no raw producer payloads. Review also retained cancelled/timed-out handlers inside the outstanding-work bound until settlement. Focused tests and typecheck passed. |
| 7 — Subscriptions/resync (`97ccd3ae`) | Bounded replay and reservations, acknowledgement-before-replay, ordered delivery across replay/live bursts, epoch/coverage/expiry resync. Replay, bootstrap and CLI regressions plus typecheck passed. |
| 8 — Lifecycle/security proof | Cross-process same-owner reuse/reconnect, profile/candidate isolation, byte-budget replay coverage and final source/dist validation. Review hardened missing-socket labels, same-descriptor bounded configuration inspection without secret loading, sanitized private launch/config diagnostics, abrupt-stream disposal and uncertain mutation cancellation. |

## Scope and safety review

The production bridge advertises five control methods and three service event types. Work/Activity/Task/approval projections and mutations belong to PR 4. Rich Models/provider diagnostics belong to PR 6. No fixture state is reachable through production CLI flags or ordinary RPC. Test-only injected readers exercise failure/race behavior without a second runtime.

The supervisor probe is additive and authenticated; legacy mutation semantics are unchanged. Current host generation support is explicitly false, so Desktop mutations remain unavailable. PR 4 must extend the trusted host/receipt boundary before enabling them; stripping or merely echoing generations is prohibited. Existing operation-ID creation, expiry and receipt ownership remain core-owned.

Bootstrap configuration inspection uses a bounded regular-file read and skips credential environment loading. Existing runtime/CLI config loading keeps its prior behavior. A configured route is not proof of credential or provider readiness. Credential staging writes no config, `.env`, OAuth state, global profile pointer or transaction receipt. Sender isolation in Electron and reviewed Apply consistency remain PRs 5/6 gates.

Relevant threat cases: D01–D07 (transport, scope, secrets, owner/authentication, uncertain outcomes and floods), D15 (compiled CLI/bridge compatibility) and D16 (no production fixture fallback). Tests use temporary homes and a fake execution handler behind the real authenticated endpoint, not user providers/accounts or installed services. No dependencies or lockfile changes are part of PR 3.

## Validation

Node **v24.14.1**, pnpm **10.33.0**. Earlier slices were reviewed and checked individually before their commits. Broad checks used a clean copy of tracked files plus explicitly added PR 3 files, excluding unrelated untracked duplicates in the operator checkout.

- Frozen dependency installation passed; no dependency versions or lockfile changes.
- Root typecheck and `desktop:foundation:check` passed, including both private workspace typechecks and the pure import boundary.
- Focused service/core checks passed **33 tests in 10 files**. The final diagnostic/disposal review regressions also passed their targeted rerun and are included in the final full suite.
- Final `pnpm run test --maxWorkers=2`: **10,760 passed in 646 files**. The complete validation was rerun after the last review corrections.
- Source smoke: **13 passed**. Build, runtime-import audit and emitted-ESM audit passed. Distribution smoke: **13 passed**.
- `npm pack --ignore-scripts` contained the emitted service and no private `apps/` or `packages/` payload. The extracted CLI ran from a directory containing spaces and Arabic text, with that relocated package as its working directory. Initialization, bootstrap, subscription, isolated descriptor-3 credential stage/discard, no state writes and clean shutdown passed. The proof reused the locked installed dependencies; it is not a fresh registry-consumer install or Electron/native-ABI certification.
- Documentation links, exact file comparison to the validation copy and `git diff --check` passed. Final executable sources matched the validated copy; this results-only documentation update followed those checks.

Local socket/process checks used their required execution permissions and temporary homes. No user providers, paid model calls, channels, operating-system services, active-profile selection or real credential files were modified. This was local Node source/dist validation, not a hosted CI run, Node 22 run, Docker release wrapper or signed Electron lifecycle certification.

Final review found no remaining gap in the implemented PR 3 scope. Work controls, trusted target-generation enforcement, Electron sender isolation and reviewed credential Apply remain explicit later delivery gates. Rollback removes the bridge and optional inspection path; there is no state migration or new credential persistence to reverse.
