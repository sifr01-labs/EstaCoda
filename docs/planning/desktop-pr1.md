# Desktop PR 1 implementation record

Status: implemented on `ame/desktop-foundation`, branched directly from `ame/execution-baseline`. This is the architecture and workspace foundation, not a running Electron app. The approved visual reference was carried into this branch with the first scope commit.

## Five commit slices and review

| Slice | Delivered and reviewed |
| --- | --- |
| 1 — Product scope and canonical ownership | Added the [architecture baseline](../architecture/desktop/README.md), delivery/ownership matrix, current core code anchors and accessibility requirements. Preserved the approved visual contract and frozen assets; marked the older concept superseded. Checked links and reference hashes. |
| 2 — Renderer/service/provider/channel threat model | Added [16 boundary cases](../architecture/desktop/threat-model.md) with required enforcement, implementing PR and verification examples. Distinguished existing core controls from future Desktop protections. |
| 3 — Credential transaction and secret boundaries | Added [staging/transport/apply decisions](../architecture/desktop/credential-transactions.md), concrete bounds, cancellation/commit races and profile isolation. Review identified existing sequential setup writes as a PR 6 consistency/recovery gate, not an atomicity guarantee. |
| 4 — Protocol and process decisions | Added [protocol/process/packaging ADRs](../architecture/desktop/decisions.md). Recorded the current non-JSON-RPC host v1 envelope, absent generation/capability contracts, private process ownership, package facade strategy and later packaged proof gates. |
| 5 — Shared protocol workspace registration | Registered private Desktop and control-protocol workspaces, extracted the existing pure core contract, preserved legacy gateway exports, and added workspace/type/import-boundary checks and compatibility tests. Reviewed build/pack behavior and executed the validation below. |

## Implemented foundation

The canonical request type, validator and existing frame limit now live in [core control-protocol](../../src/contracts/control-protocol.ts). The gateway uses that source while preserving its prior exports. [The private package](../../packages/control-protocol/README.md) re-exports the same source; [Desktop](../../apps/desktop/README.md) consumes it through `workspace:*`.

The root CLI retains its existing `src` → `dist` layout and has no runtime dependency on either private package. No external dependency versions changed; the lockfile adds only the two workspace importers and their local link. The validator was compared text-for-text with its previous implementation. No request semantics, authentication, receipts, profile storage, schema, execution ownership or approval policy changed.

`pnpm run desktop:foundation:check` typechecks both workspaces without ambient Node/DOM globals and checks their transitive source import boundary. It rejects Node/third-party dependencies, gateway source imports, dynamic imports and CommonJS imports along that boundary. It is an import check, not a substitute for later Electron isolation tests. Temporary negative probes verified the Node, gateway and dynamic-import rejection paths and were restored before final tree comparison.

## Validation performed

Validation used Node **v24.14.1** and pnpm **10.33.0** in an isolated copy exported from the reviewed Git index, excluding the operator checkout's unrelated untracked duplicate files. Final executable sources match that copy apart from removal of an extra trailing blank line. Documentation/record updates were reviewed separately. The Desktop foundation check also passed in the operator checkout after its frozen installation completed.

- `pnpm install --frozen-lockfile --offline` passed in the isolated copy. The operator checkout's offline install encountered a cache miss; a frozen install with registry permission then completed without lockfile changes.
- `pnpm run desktop:foundation:check` passed in both copies.
- Focused control-contract/private-control/receipt/shared-host/startup tests: **15 passed in 5 files**.
- `pnpm run typecheck` passed.
- `pnpm run test --maxWorkers=2`: **10,687 passed in 634 files**.
- `pnpm run smoke`: **13 passed**.
- `pnpm run build` passed.
- `pnpm run audit:runtime-imports` and `pnpm run audit:esm` passed.
- `pnpm run smoke:dist`: **13 passed**.
- `npm pack --ignore-scripts --json` with an isolated writable cache produced the CLI package. Its payload contains the compiled pure contract and no `apps/` or `packages/` tree. An extracted package imported its gateway validator and ran `dist/index.js --version` successfully using the already-installed locked runtime dependencies; no fresh public-registry consumer install is claimed.
- Approved-reference hashes, relative documentation links, validator extraction equality and `git diff --check` passed.

Local socket/process tests ran with the permissions needed by the existing test suite. This was not the Docker release wrapper, a live provider test, a signed Desktop lifecycle proof, a Node 22 CI run, or cross-platform validation. No accounts, channels, operating-system services or paid model calls were configured for this work.

## Remaining delivery gates and risk

PR 2 must add strict Desktop envelopes, projection/result schemas and bounded events rather than treating host v1 as JSON-RPC. Target generation must reach the trusted mutation boundary before dependent methods are advertised. PRs 3–5 deliver the real bridge, isolated credential pipe, secure shell and lifecycle proof. PR 5 must meet the approved visual acceptance matrix. PR 6 must prove multi-file apply consistency and recovery; PR 8 reuses that path. Later packaging must verify Electron/native-module compatibility and signing.

Security-sensitive change in this PR is limited to extracting a shared validator that still has the same behavior and compatibility export. There is no persistence migration or permission widening. Reverting the package registration/extraction requires no data rollback. The private facade is intentionally monorepo-only and must not be published independently. Unrelated untracked files were left out of all five commits.
