# Workspace execution PR 1 implementation record

Status: implemented on `ame/execution-baseline`, continuing PR 0 at the operator's request. Scope is stable named workspaces, core local targets and profile/workspace ownership validation. [Operator documentation](../operations/workspaces.md) describes the implemented behavior; later authority, environment and cross-process owner work remains in the [plan](workspace-execution-implementation-plan.md).

## Commit review ledger

Each implementation step was reviewed and tested before proceeding. The seventh commit records public behavior and the validation results below.

| Step | Commit | Review and checks |
|---|---|---|
| 1. Compatible identity extraction | `0db4f598` | Existing canonical-path SHA-256 semantics preserved; Task compatibility export retained. 12 focused tests and typecheck passed. |
| 2. Profile-local registry | `e06f3a2e` | SQLite transactions, alias uniqueness, stable IDs, move revisions, directory validation and no trust mutation. Four focused workspace tests and typecheck passed. |
| 3. Core targets and bindings | `dbb6955f` | Local-only target records; additive Session schema 33; immutable Session/Task bindings and inherited provenance. 79 focused tests and typecheck passed. |
| 4. CLI selection | `30335f2e` | All seven workspace commands and prefix-only alias selection; benchmark option compatibility; no active-profile or trust writes. 66 focused tests and typecheck passed. |
| 5. Common ownership validation | `e3618924` | Construction, resume, child/Task dispatch, ACP and gateway attachment checks; bounded legacy binding and metadata compare-and-set. 453 focused tests, ACP lifecycle tests and typecheck passed. |
| 6. Regressions and review fixes | `07e43ad2` | Independent-process registry/target/Session races, legacy reopen, path aliases, move/trust separation, CLI/channel pointer preservation and ACP transcript boundaries. Review fixed bounded `/switch` failure reporting, configured state-home propagation in the CLI picker, and the local `sessions attach` workspace check. Full validation below. |
| 7. Documentation | `docs(workspaces): document selection trust and migration behavior` | Commands, implemented guarantees, legacy handling, backup/downgrade constraints and future ownership limits checked against source. Historical PR 0 measurements preserved. |

The full suite initially exposed two nonexistent-directory picker fixtures and four old-schema migration fixtures. They now use valid directories or accurately remove schema 33 when constructing an older database. The session smoke fixture now uses real SQLite targets and tests alias rename. Expected behavior was not weakened to accommodate these failures.

## Validation

Validation uses the isolated tracked checkout with only reviewed PR 1 changes copied in, because the operator checkout contains unrelated untracked duplicate files. Those files were not modified, removed or staged. Dependencies were installed with the frozen lockfile; no dependency or lockfile change is part of PR 1.

| Check | Result |
|---|---|
| `node --version` | `v24.14.1` |
| `pnpm --version` | `10.33.0` |
| `pnpm install --frozen-lockfile` | Passed; initial offline cache miss resolved by the authorized registry installation |
| `pnpm run typecheck` | Passed |
| `pnpm run test` | 10,430 tests passed across 589 files |
| `pnpm run smoke` | 13/13 passed |
| `pnpm run build` | Passed |
| `pnpm run audit:runtime-imports` | Passed |
| `pnpm run audit:esm` | Passed |
| `pnpm run smoke:dist` | 13/13 passed |
| `git diff --check` | Passed; new documentation links checked |

CI's Node 22.18.0 lane has not been run locally. Local tests use synthetic providers and temporary state; no live accounts, paid models, Desktop process, container or remote environment were exercised. The PR 0 host measurement JSON was not regenerated, and no new latency or production-cost claim is made.

## Risk and follow-up

This change touches profile isolation, persistent schema migration, runtime construction and session attachment. Ownership mismatches and ambiguous remote legacy records fail closed. Registry writes coordinate across processes; this is not a lease granting exclusive Session execution. Existing profile trust, approvals and the hardline floor retain their roles.

Session migration backups are best-effort. Operators should make a consistent stopped-process backup of global Session state and profile workspace state. Old binaries are not reliable readers of migrated ownership fields; downgrade requires a compatible snapshot. Profile-directory renaming is not a migration of persisted ownership IDs.

PR 1 closes baseline B03. B01/B02/B04 (cache acquisition, supervisor liveness, cross-process Session execution) remain PR 4 work. Environment labels and reusable authority remain PR 2 work; host execution leases and process lifetime remain PR 3 work. No concurrent multi-surface execution safety or managed multi-tenant infrastructure guarantee follows from this PR alone.
