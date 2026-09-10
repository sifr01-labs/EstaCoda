# Desktop protocol, process and packaging decisions

Status: Desktop PR 1 decisions; implemented foundation and pending transport work are distinguished below. These consume the [shared ownership decision](../../planning/workspace-execution-ownership-decisions.md), not a replacement execution architecture.

## ADR D-001 — Keep one protocol source without disrupting CLI packaging

Current core control is implemented in [private-control.ts](../../../src/gateway/private-control.ts). Before Desktop PR 1, its `PrivateControlRequest` type and validator were colocated with Node socket/discovery code. A `packages/control-protocol` directory did not exist, despite the planned layout. Core target implementation likewise lives in `src/workspaces`, not the plan's illustrative `src/execution-targets` directory.

PR 1 extracts only the existing pure request contract/validator and frame-limit constant into `src/contracts/control-protocol.ts`. The gateway imports that source and preserves its existing exports for callers. A private `@estacoda/control-protocol` workspace package re-exports the same source for the private `@estacoda/desktop` workspace. It has no Node, Electron or third-party runtime dependencies. This is an explicit source facade inside this monorepo, not a separately publishable package or a copied protocol implementation.

Why keep canonical source under `src`: the released CLI compiles `src` to `dist` and ships no private workspace packages. Moving runtime source outside that root would change emitted paths or introduce an unpublished runtime dependency. Relative core imports preserve the current distribution. Desktop's later bundler consumes the pure workspace facade; it must not import gateway internals into the renderer. Foundation typechecks and import-boundary checks establish this dependency graph before Electron arrives.

Register only `apps/desktop` and `packages/control-protocol` as workspaces now. Preserve root dependency versions and pnpm overrides/build approvals. No Electron/Forge/React dependency, renderer, command entry point, service stub or future-method registry is needed in PR 1. PR 5 owns the Electron scaffold. Future pure protocol modules must remain compatible with the root release build; expanding the facade does not justify duplicating definitions.

## ADR D-002 — Preserve existing host wire v1; add Desktop transport explicitly

The current private Unix endpoint is **not JSON-RPC 2.0**. It accepts a single newline-delimited authenticated envelope per socket with `protocol: 1`, exact runtime `version`, supervisor `instanceId`, token and a request. Responses are `{ ok, result }` or a bounded error. It does not implement `control.initialize`, subscriptions, capability negotiation, typed result schemas, or a target-generation field. Its discovery token stays inside trusted core transport and is not exported by the pure package.

Current semantic methods:

| Host method | Input / behavior |
| --- | --- |
| `send` | Session/target/operation IDs plus 1–32,768-character text; accepted work is serialized by the owner |
| `cancel` | Session/target/operation IDs; returns requested versus confirmed termination separately |
| `approval` | Session/target/operation IDs plus approval ID and approved/denied decision; owner routes local/channel handling |
| `inspect` | Same binding IDs; read existing receipts and execution/approval status; does not create a new mutation |

The current request validator restricts method, identifier format and method-specific required input, but is not a strict unknown-key validator or authorization check. Keep its wire behavior unchanged in PR 1. The transport's 131,072-byte frame cap and receipt retention are existing host constraints, not a complete Desktop protocol spec.

PR 2 adds Desktop's versioned JSON-RPC/NDJSON envelopes, strict bounded schemas, safe result projections, capability negotiation, cancellation and event cursor semantics through this shared package. PR 3 adapts to supported host methods through the existing core client. Keep legacy host framing internal; never expose token/socket access or pass arbitrary renderer requests to it. Methods requiring unavailable host contracts remain unadvertised. Expected target generation must be enforced at the trusted execution boundary, not merely compared in a renderer or discarded by an adapter; coordinate additive/versioned core changes and conformance tests before enabling those mutations.

Do not claim wire compatibility between the two envelopes, reuse one version number for both, or loosen v1 authentication/version checks to connect an incompatible binary. A future host transport upgrade requires an explicit protocol/version migration and core-client tests. Until then, the bridge consumes one canonical semantic contract through an adapter, not a second supervisor implementation.

## ADR D-003 — Private process ownership and reconnect

Main owns one profile-bound bridge per client context via private child stdio and a separate credential pipe. Stdout is bounded control messages only; stderr is bounded/redacted diagnostics. No localhost HTTP/WebSocket listener. The bridge owns projection/setup staging; the independently running profile supervisor owns shared execution. Reuse private discovery, singleton, service-manager and on-demand startup machinery. Renderer, bridge or window loss detaches a client and never proves shared execution stopped.

Bootstrap/provider repair must work without a supervisor. Starting Work may request the owned on-demand host path without installing a login service, enabling channels, or changing the active-profile pointer. Reuse a compatible running host; version mismatch needs repair guidance, not a second process. The bridge cannot kill an independently owned supervisor during cleanup. On-demand automatic idle shutdown is not currently promised.

After bridge restart, discard candidate IDs, handles and stream cursors tied to that instance. Reinitialize, obtain a consistent snapshot/cursor boundary and query uncertain mutation receipts. Do not replay mutations from a renderer queue blindly. Streams need bounded buffers, explicit overflow/snapshot-required responses and priority control handling. Existing private host receipts bind profile, trusted principal, method and operation ID to canonical input; they persist safe references and return uncertain rather than promise exactly-once external effects.

`profiles.use` in the planned Desktop catalog means replace the window's bound client context. It does not mean mutate global `active-profile.json`. Destroy the old bridge/context and clear staged material/subscriptions/handles before activating the next one; old shared execution remains owned by its supervisor. Foreground CLI/ACP keep their current standalone path; attachment to shared execution is distinct from settled ownership transfer.

## ADR D-004 — Semantic catalog, safe events and scope

The [method/event catalog](../../planning/desktop-implementation-plan.md#82-method-groups) is a delivery map, not a list of implemented exports. Do not generate every planned method in PR 1. PR 2 starts with the first usable initialization/bootstrap/Work flow and extends the shared schema only as consumers arrive.

| Method group | Owning slice / routing |
| --- | --- |
| Initialize/bootstrap/subscriptions/profiles | PRs 2–3, profile-bound bridge; profile switch mediated by Main |
| Work/Session/Task/Inbox/approvals | PRs 3–4 and live UI PR 7; shared supervisor/core owner |
| Providers/models/routes/OAuth | PR 6; reviewed setup and isolated candidate path |
| Connections/Telegram/gateway/handoff | PR 8; existing channel/lifecycle owners |
| Targets/worktrees/files/diff/PTY | PRs 9–10; core target capabilities, separately owned human PTY |
| Artifacts/evidence | PR 11; existing retention and safe projections |
| Browser snapshots/control | PRs 12–13; policy then explicit fenced takeover |
| Governed settings/Library/schedules | PRs 14–15; reviewed apply and existing stores |

Notifications project assistant activity, tools, plans, Work/Task changes, approval state, usage, provider/connection readiness and artifact/evidence changes. They carry instance/stream/subscription identity, sequence and bounded safe payloads. They are not raw runtime event objects, authority grants or a durable queue. Typed errors distinguish validation, unauthorized/stale binding, conflict, unavailable, snapshot-required and uncertain outcomes without disclosing secrets. Precise executable schemas and limits ship in PR 2, with independently tested serialization/parsing.

## ADR D-005 — macOS packaging and proof gates

Use Electron + React + TypeScript with Forge/Vite in PR 5, not a web server or a second embedded agent runtime. Bundle compatible owned Node runtime/service assets; do not trust a renderer-provided binary or an arbitrary PATH match. The Electron native-module ABI and standalone Node CLI ABI need separate verification. Preserve the root `dist/index.js` executable and published CLI file layout.

The first packaged macOS proof in PRs 3–5 must cover bridge launch, existing-profile bootstrap, canonical Work/approval inspection, bridge restart with the same supervisor, full quit/relaunch, profile switch, and explicit supervisor restart. Test relocation, paths with spaces/Unicode, concurrent clients and incompatible installed versions. OS signing/notarization and final release artifact checks remain PR 16. Do not install a login service during first launch; service installation is an explicit operator choice.

Windows requires a protected named-pipe host equivalent before advertising shared-control support. No signing credentials, auto-update feed, package publication, service installation or remote-control endpoint is introduced by this foundation. Package dependency upgrades must be assessed at the implementing PR, not inferred from the design reference's CDN helpers.

## Consequences and release criteria

The minimal package extraction is source organization, not a protocol upgrade. Existing CLI imports and host behavior must pass unchanged. PR 1 checks pure import boundaries, workspace resolution, typechecking, host-control/receipt regressions and the root release validation suite. No Session schema or credential migration is part of this PR. Rollback removes the facade and restores the in-module declarations; it requires no data migration.

Packaged lifecycle, strict Desktop parsing/generation enforcement, safe projection streams, credential commit recovery, Electron isolation and visual acceptance remain explicit later gates. Implementing the approved design never authorizes bypassing them.
