# PR 7 — Temporary copies and authorized change application

Status: implemented on `ame/execution-baseline` in the seven prescribed commits. See [operator workflows and limits](../operations/temporary-copies.md). PR 7 does not change the shared source/target identity or execution-owner decisions.

## Commit review

1. `afad55e0` — Bounded explicit manifests, binary/mode snapshots, copied-root identity, core temporary-copy target records and the existing workspace CLI consumer. Review checked source trust, input selection, path/type exclusions, separate targets, and refusal to adopt a replaced copy. Typecheck and 7 focused tests passed.
2. `029d5259` — Existing artifact-store retention with workspace-change provenance, immutable baseline hashes, create/update/delete exports and profile ownership. Review checked storage tampering, artifact/source identity and dependency exclusion. Typecheck and 6 focused tests passed.
3. `c5db2d93` — Exact-path/mutation task-start application plans, immutable review-only decisions and existing approval-store grants/revocations. Review checked scope expansion and destructive-operation classification. Typecheck and 17 focused tests passed.
4. `3aa03f49` — Source trust/provenance checks, all-path conflict preflight, bounded file mutation, a shared source mutex and local foreground finishing. Review checked writable destination containment, source preservation on conflicts, artifact registration and runtime ownership. Typecheck and 8 focused tests passed.
5. `d16b491b` — Durable per-file intent/progress, idempotent receipts, guarded rollback, interrupted-create staging reconciliation and copy-aware workspace database version 2. Review covered real process exits before progress settlement, later edits and old-reader fencing. Typecheck and 14 focused tests passed.
6. `d573b2ec` — Runtime, malicious-artifact, Git input/dependency, source-root, profile, delete and independent-process conformance. The actual runtime exposed generated state that must be excluded from exports; review also tightened current-channel checks so remote attachment cannot consume local finishing authority. Focused checks passed (43 tests across 14 files, then 4 recovery/race tests), as did the expanded real-Docker source gate.
7. `docs(workflows): document automatic application and review-only modes` — Operator commands, authority, compatibility, recovery and limits. Final workflow review also ensured no-change turns leave the copy usable, active managed/child work defers automatic finishing, and artifact events use the current Session after rotation. Final validation is recorded below.

## Implemented behavior

Copies use an explicit source manifest with tracked/untracked/dependency origins, preserved binary bytes and modes, baseline content hashes, and source/copy directory identities. They are core target variants, not another workspace or execution-owner registry. The actual copy root remains the Session/Task working identity. The first copy advances the profile workspace registry to version 2, fencing older readers that could otherwise reinterpret it as a local target.

Exported changes use the existing artifact store and Session artifact registration contract. The profile workspace database retains manifest, application-authority, artifact-registration reference and recovery rows. No Desktop-only artifact store, scheduler, provider tool or new dependency was introduced.

Application plans bind one copy/source baseline to exact paths and create/update/delete operations. They use the existing workspace approval store and current revocation checks. Exports cannot mint grants. Covered local foreground CLI work can finish without another application approval; review-only work remains review-only. Conflicts preserve the batch before mutation, and unexpected partial failures retain a journal for explicit guarded rollback.

## Validation

Validation uses the isolated tracked checkout at `/private/tmp/estacoda-pr4-v9ww3gws`; unrelated operator duplicates and `exports/` remain untouched. No dependency or lockfile changes.

Validated with Node 24.14.1 and pnpm 10.33.0:

- Frozen-lockfile installation, typecheck and production build passed.
- Final full suite: 10,594 tests passed across 628 files. The final no-change and busy-work regressions also passed independently (10 tests across 2 files).
- Source smoke and compiled-distribution smoke each passed all 13 cases.
- Runtime-import and compiled ESM audits passed.
- The real Docker gate passed against both source and compiled modules, including temporary-copy writes, preauthorized application, guarded rollback and settled ownership receipts.
- Documentation relative links and `git diff --check` passed.

Local validation did not run the Node 22 CI matrix, live model-provider calls or packaged Desktop delivery. Runtime acceptance tests use a scripted provider with the actual runtime, tools, policy, ownership and storage.

## Security review and remaining limits

This is sensitive filesystem, approval, artifact, runtime and recovery work. Review traced temporary-copy acquisition into common runtime Session binding; provenance/hash/path/mutation validation before source writes; grant revocation; rollback reconciliation; source/application races; and the model-facing result when application is blocked. Malicious artifacts cannot choose arbitrary destinations or grant themselves authority. Actual Docker copy writes and application/rollback are exercised separately from the fake provider used in runtime tests.

The local operator, runtime state, engine and same-user host processes remain trusted. The shared application mutex coordinates EstaCoda, not arbitrary editors. Per-file replacement plus a journal is not an atomic multi-file filesystem transaction or a power-loss guarantee. Keep other writers settled during application/recovery. Rollback checks current bytes/mode and preserves later edits; it cannot undo external side effects.

Automatic finishing is currently local foreground CLI only. Remote/attached, ACP and background/child work use the explicit local finish/export workflow after settlement. Active managed/child work defers automatic finishing. Copies have one nonempty application receipt; continued editing/application needs a fresh baseline. Dependencies must be explicitly available; arbitrary installs, symlinks, full dependency-tree copying, ACL/xattr/ownership transfer, directory operations and copy/artifact garbage collection are not implemented. Partially prepared copies and unresolved journals remain for review instead of being deleted speculatively.

These limits are explicit operator behavior, not claims of managed multi-tenant isolation, automatic synchronization, universal undo, or a complete cross-surface release matrix. PR 8 and packaged Desktop delivery remain separate work.
