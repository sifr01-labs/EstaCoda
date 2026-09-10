# Desktop PR 2 implementation record

Status: implemented and validated on `ame/desktop-foundation` in the six prescribed commits. This slice supplies the pure Desktop control protocol, not a running service or UI.

## Six commit slices

1. Versioned JSON-RPC envelopes, bounded LF framing, safe fixed errors, JSON serialization checks and shared package exports.
2. Initialization, same-major version/capability negotiation, profile/bootstrap types and instance/stream cursor handling.
3. Work, activity, Inbox, model, provider and connection projections; typed method requests/results, receipts and events.
4. Strict runtime schemas with closed fields, limits and profile/request/target/receipt/subscription correlation. Added duplicate-key detection before JSON parsing loses that information.
5. Conformance fixtures for every declared method/event through the Desktop package, malformed-input corpus, Unicode/frame limits and cancellation/reconnect cases. Full source typechecking caught and corrected a heterogeneous test-array inference issue; runtime guards were not weakened.
6. [Protocol reference](../architecture/desktop/control-protocol.md), scope/compatibility updates and this record. Documentation review tightened subscription acknowledgement: a cursor cannot resume against a filtered subset of its negotiated event set. The matching regression is included and final validation reruns that exact source.

Each slice received a source/contract review and focused checks before committing. The last slice includes the narrow reconnect guard uncovered while documenting the end-to-end contract.

## Delivered behavior and limits

The [shared pure modules](../../src/contracts/desktop-control/index.ts) define Desktop protocol v1.0 separately from the existing private supervisor v1 wire. Desktop's workspace facade consumes the same source; core CLI builds continue to emit self-contained `dist` files. No external dependencies, lockfile changes, store migrations or legacy private-control behavior changes are part of PR 2.

Implemented schema scope is **17 methods and 8 event types**. Capabilities intersect the client's request with known, explicitly implemented server handlers; schema existence grants no authority. Envelopes reject batches, duplicate keys, unsafe error bodies, non-JSON values and unknown fields. Runtime validators enforce initialization, negotiated methods, target generations, exact receipt correlation, profile isolation in projections, bounded pages and scoped notifications.

The protocol preserves unknown/expired/uncertain receipt states and requested versus confirmed cancellation. It does not infer external success from a receipt or simulate a runtime. Safe projections expose credential presence metadata, not raw credentials. A validator cannot detect every secret embedded in legitimate text; producers still need bounded explicit projections and redaction.

PR 3 must implement the actual private byte-stream transport, strict UTF-8 decoding and incomplete-buffer limits, service lifecycle, snapshot-bound reads, replay storage/backpressure, priority cancellation, safe projection producers and trusted dispatch. The existing host wire lacks expected-generation fields; do not discard them in an adapter or advertise a mutation before its trusted boundary supports them. Remaining delivery-plan methods arrive with their real consumers; no speculative future method registry was generated.

## Validation

Node **v24.14.1**, pnpm **10.33.0**. Broad validation used an isolated copy of the reviewed Git index plus the explicit final reconnect correction; unrelated untracked duplicate files in the operator checkout were excluded. Focused protocol and workspace checks also ran in the operator checkout.

- Frozen dependency installation passed after an offline cache miss and a retry with registry permission; dependency versions and lockfile remained unchanged.
- `pnpm run desktop:foundation:check` passed: both workspace typechecks and the transitive import boundary (nine pure source modules).
- Focused protocol tests: **45 passed in 4 files**, covering all 17 methods, all 8 event payloads and negative cases.
- `pnpm run typecheck`, `pnpm run build`, `pnpm run audit:runtime-imports` and `pnpm run audit:esm` passed on the final source.
- Final `pnpm run test --maxWorkers=2`: **10,732 tests passed in 638 files**, including the reconnect event-set correction. The earlier full run also passed; it was repeated after that final change.
- `pnpm run smoke` and `pnpm run smoke:dist` passed all **13 cases each** on the final source/build.
- The emitted protocol round-tripped and validated an initialization request under Node; `node dist/index.js --version` succeeded.
- Document links, exact source comparison to the validation copy and final `git diff --check` passed.

Socket/process tests used their required execution permissions. This was not a live provider/account test, Docker release certification, signed Electron proof, Node 22 run, or cross-platform validation. No provider credentials, operating-system service or channel configuration were changed.

## Risk and follow-up

These parsers/validators are security-sensitive future trust boundaries. They fail closed on malformed data, but do not authorize send/approval/target access, create durable receipts, enforce sender identity or own shared execution. PR 3 must compose them with those core checks; passing pure protocol tests does not establish that integration. Renderer isolation and the approved visual acceptance gate remain PR 5. Multi-file credential apply consistency remains PR 6.

Reverting this additive protocol removes the new exports and contract consumers; it requires no data migration or runtime-policy rollback. Existing private host APIs remain available unchanged.
