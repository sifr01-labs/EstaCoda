# EstaCoda Desktop implementation plan

Status: implementation plan with approved Desktop visual direction, version 1 · 10 September 2026. PR 5 now includes the complete approved interface and visual acceptance gate; production integrations remain sequenced below. Planned capabilities are not claims of shipped functionality.

The [Desktop visual and interaction contract](desktop-visual-contract.md), [frozen branded prototype](desktop-design/README.md), and [acceptance matrix](desktop-design/acceptance-matrix.md) are required inputs to PR 5 and subsequent UI work. They supersede earlier visual concepts. PR numbers in this document refer to Desktop, not the workspace-execution series.

Shared contract and ownership decisions are defined in [Shared workspace, target, and execution ownership decisions](workspace-execution-ownership-decisions.md). That document is authoritative for overlap with the workspace plan. The architecture below consumes its core target bindings and supervisor ownership; these are proposed capabilities, not shipped behavior.

## 1. Product objective

EstaCoda Desktop should be an operator console for trusted, persistent agent work. It should let a user configure a runnable model, connect approved remote surfaces, start and supervise work, intervene at trust boundaries, inspect execution in the correct environment, and verify outcomes without replacing the existing EstaCoda runtime or weakening its safety model.

The center of the product is Work, not a generic chat transcript. Conversation remains an important collaboration surface inside Work.

The first public-quality alpha should let a user:

1. Launch a secure desktop application.
2. Select or repair one profile.
3. Add and verify a model provider.
4. Choose a primary model and fallback chain.
5. Attach a trusted local workspace or create a managed Git worktree.
6. Start or resume Work.
7. Observe streaming, tools, plans, Tasks, child agents, approvals, cost, and evidence.
8. Intervene through approve, reject, guide, pause, resume, cancel, and retry actions where the backend supports them.
9. Configure Telegram as a denied-by-default remote control surface.
10. Continue a session between Desktop and Telegram.
11. Inspect files, Git diff, terminal output, artifacts, and verified evidence in the exact execution target.
12. Close and reopen the app without losing durable state.

## 2. Locked architecture decisions

1. Use Electron, React, and TypeScript for the desktop application.
2. Keep the existing Node/TypeScript EstaCoda runtime canonical.
3. Electron Main launches a profile-bound `DesktopControlService` client bridge. The existing profile-bound supervisor owns shared execution independently of Electron; the bridge does not run a second scheduler, channel poller, or shared agent loop.
4. Use versioned JSON-RPC over private stdio between Main and the bridge. The bridge reconnects to the supervisor through authenticated private local IPC as defined in the shared decision. Do not open a local HTTP server.
5. Use a separate non-logged child-process pipe for staged credential material.
6. Treat the renderer as untrusted:

   - `nodeIntegration: false`
   - `contextIsolation: true`
   - Chromium sandbox enabled
   - no filesystem, database, shell, Git, browser/CDP, credential-store, provider, channel-adapter, or runtime access
   - a narrow semantic preload API only

7. Sessions, Tasks, Cron jobs, approvals, trust, configuration, provider usage, and channel mappings remain canonical.
8. `Work`, `Run`, `Inbox`, and `Evidence` begin as projections, not new persistence models.
9. Desktop consumes core execution target records and immutable bindings. The first Desktop target types are local workspace and managed Git worktree; source workspace identity and environment policy remain separate.
10. Worktrees provide concurrency and change isolation, not security isolation.
11. Configuration changes use `draft -> review -> confirm -> apply -> verify`.
12. Setup cancellation and blocked apply write neither configuration nor credentials.
13. API keys remain profile-local in `.env`; OAuth tokens remain profile-local in `auth.json`.
14. Human terminal and browser actions never imply approval for agent actions.
15. `ChannelGateway` remains the channel authorization, session, approval, and delivery orchestrator. Desktop never mutates adapters or the approval queue directly.
16. A model known to the catalog is not necessarily executable. Only runnable, credential-ready routes may be selected for Work.
17. Plugins, arbitrary event subscriptions, containers, remote environments, organization management, and automatic updates remain outside the first alpha.
18. Closing Desktop or switching its profile detaches that client; shared Work continues under the supervisor within its established authority and lifetime. Foreground CLI/ACP remain daemon-free and use the same session ownership checks.

The existing terminal UI is already named the Operator Console. Name the desktop backend `DesktopControlService` to avoid colliding with the Papyrus surface documented in [Operator Console](../subsystems/operator-console.md).

## 3. Product information architecture

The permanent shell follows the approved neutral sidebar, flexible primary surface, collapsed-by-default inspector, and bottom runtime strip. Geometry, palette, assets, and interaction details are locked in the [visual contract](desktop-visual-contract.md).

```text
┌─────────────┬────────────────────────────────────┬────────────────┐
│ Brand / ⚙   │ Primary surface                    │ Inspector      │
│ Search / +  │                                    │ collapsible    │
│ Work        │ New chat or selected Work          │                │
│ Inbox       │                                    │ Plan           │
│ Library     │ Activity / Changes / Results       │ Execution      │
│ Connections │                                    │ Usage          │
│             │ Conversation or operational view   │                │
│ Pinned Work │                                    │                │
│ Workspaces  │ Composer: + / safety   model / send │                │
├─────────────┴────────────────────────────────────┴────────────────┤
│ Runtime connection / running / attention / background schedules   │
└──────────────────────────────────────────────────────────────────┘
```

PR 5's isolated fixture showcase implements all approved destinations. In the live application, navigation entries appear only when functional, and actions follow advertised capabilities. Models is reachable through Settings before new Work because an unconfigured profile must be repairable; it is not an additional primary navigation item. Connections becomes live when Telegram setup and status are implemented. Never populate live views with sample data to imitate the showcase.

Primary experiences:

- **Inbox**: approvals, input requests, failures, trust/setup blockers, Evolution reviews, and delivery issues.
- **Work**: sessions, durable Tasks, runs, activity, controls, and outcomes.
- **Models, within Settings**: providers, credentials, primary route, fallbacks, specialist routes, and diagnostics; the composer exposes per-Work model selection.
- **Connections**: Telegram first; later Discord, Email, and explicitly experimental WhatsApp.
- **Background work, from the status strip**: runtime state and existing once, interval, and Cron jobs plus execution history.
- **Library**: Artifacts and Skills & tools first; evidence, memory, and Evolution use the same hierarchy as their capabilities arrive.
- **Settings, from the sidebar top icon**: Appearance and Models, followed by governed profile, trust, security, browser, voice, optional capabilities, diagnostics, and lifecycle controls.

Search and New chat sit below the sidebar identity. Pinned Work precedes workspace-grouped chats. The composer keeps attachments and safety on the left and model/send on the right. Neither pinning nor search changes canonical Work ownership.

## 4. Process architecture

```text
Electron renderer
  React UI and non-authoritative view state
        │ narrow contextBridge methods and notifications
Electron preload
  runtime validation and semantic API
        │ Electron IPC
Electron Main
  secure windows, bridge lifecycle, protocol client, OS integration, human PTY
        ├── JSON-RPC 2.0 / NDJSON / private stdio
        └── credential staging / dedicated non-logged pipe
DesktopControlService
  profile-bound client authorization, projections, setup drafts, verification
        │ authenticated private local IPC / reconnect
Existing profile-bound supervisor
  shared session execution owner and runtime coordinator
        ├── Sessions / Tasks / Cron / approvals / trust
        ├── providers / OAuth / credential resolver / usage ledger
        ├── ChannelGateway / adapters / handoff / delivery
        ├── core targets / environment leases / files / Git / browser
        └── artifacts / evidence / memory / skills / Evolution
```

One bridge process binds to exactly one profile. Multiple bridges/windows may connect to one profile's shared supervisor; they cannot create competing executors. Switching profile must:

1. Stop subscriptions.
2. Cancel uncommitted credential candidates and OAuth attempts.
3. Dispose the bridge and close its Main-owned human PTYs; do not stop the old profile's supervisor or shared Work.
4. Clear renderer and Main caches, subscriptions, and target capabilities.
5. Launch a bridge bound to the new profile.
6. Reinitialize from a canonical snapshot.

Viewing or using a profile in a desktop window does not mutate `active-profile.json`. A persistent active-profile change remains an explicit `profile use` action.

Desktop bootstrap/setup works without an execution host. Starting Work connects to or starts the existing supervisor through its owned launch path without automatically installing a login service or enabling channels. That host continues after Desktop exits; logout/reboot availability requires the existing explicit service-install choice. Supervisor restart, foreground CLI handoff, machine sleep, and ambiguous owner loss follow the [shared lifecycle and recovery rules](workspace-execution-ownership-decisions.md#5-lifecycle-behavior-visible-to-operators). A disconnected bridge is never evidence that execution stopped.

## 5. Proposed repository structure

The tree below remains the delivery layout, not the current filesystem. Desktop PR 1 follows the [protocol packaging decision](../architecture/desktop/decisions.md): canonical pure host contracts live under `src/contracts/control-protocol.ts`, and the private workspace package re-exports them without moving the CLI build root. Existing targets live under `src/workspaces`; extend those owners rather than creating a second target store to match this illustrative tree.

```text
estacoda/
├── apps/
│   └── desktop/
│       ├── package.json
│       ├── forge.config.ts
│       ├── vite.main.config.ts
│       ├── vite.preload.config.ts
│       ├── vite.renderer.config.ts
│       └── src/
│           ├── main/
│           │   ├── app-lifecycle.ts
│           │   ├── control-service-client.ts
│           │   ├── control-service-process.ts
│           │   ├── credential-pipe-client.ts
│           │   ├── ipc-handlers.ts
│           │   ├── terminal-manager.ts
│           │   └── window-policy.ts
│           ├── preload/
│           │   ├── api.ts
│           │   └── index.ts
│           └── renderer/
│               ├── app/
│               ├── components/
│               ├── features/
│               │   ├── inbox/
│               │   ├── work/
│               │   ├── models/
│               │   ├── connections/
│               │   ├── activity/
│               │   ├── files/
│               │   ├── diff/
│               │   ├── terminal/
│               │   ├── evidence/
│               │   ├── browser/
│               │   ├── scheduled/
│               │   └── settings/
│               ├── state/
│               └── styles/
├── packages/
│   └── control-protocol/
│       └── src/
│           ├── envelopes.ts
│           ├── methods.ts
│           ├── events.ts
│           ├── projections.ts
│           ├── validation.ts
│           └── version.ts
└── src/
    ├── control-service/
    │   ├── server.ts
    │   ├── request-router.ts
    │   ├── subscription-manager.ts
    │   ├── credential-candidate-store.ts
    │   ├── safe-runtime-events.ts
    │   ├── bootstrap-service.ts
    │   ├── work-projection-service.ts
    │   ├── activity-projection-service.ts
    │   ├── inbox-projection-service.ts
    │   ├── model-control-service.ts
    │   ├── connection-control-service.ts
    │   └── evidence-projection-service.ts
    ├── execution-targets/
    │   ├── execution-target-store.ts
    │   ├── sqlite-execution-target-store.ts
    │   ├── local-target.ts
    │   ├── git-worktree-target.ts
    │   └── git-worktree-manager.ts
    └── artifacts/
        ├── artifact-store.ts
        ├── sqlite-artifact-store.ts
        └── artifact-content-store.ts
```

The protocol package contains shared envelopes and semantic methods used by core control clients/supervisor and the Desktop bridge/Main. It must contain no Node- or Electron-specific behavior. Workspace PR 4 owns the minimal host-control contracts; Desktop extends them as projection/setup consumers arrive. Reuse that package rather than defining another host protocol.

`src/execution-targets/` is shared core code delivered first for local targets by workspace PR 1, then extended here for managed worktrees. Its storage contract and migrations have one owner. File names above are a layout guide, not a requirement to create a new database or service class. Extend existing artifact retention/Task Results and expose safe projections rather than creating a Desktop-only store. Core supervisor endpoint/session hosting remains under the existing gateway/runtime modules, not `src/control-service/`.

## 6. Canonical ownership and projections

| Domain | Canonical owner |
|---|---|
| Conversation | Session database |
| Durable work | Task/Step/Attempt store |
| Runtime authorization | Security policy and approval services |
| Scheduling | Cron store and execution store |
| Workspace trust | Global trust store |
| Configuration | Selected profile config and reviewed apply path |
| API-key credentials | Selected profile `.env` |
| OAuth credentials | Selected profile `auth.json` |
| Provider capabilities | Provider metadata and model catalog |
| Provider execution | Provider registry and executor |
| Usage and cost | Canonical provider-request ledger |
| Channel authorization and routing | `ChannelGateway` and profile channel config |
| Channel/session attachment | Channel session and handoff stores |
| Agent improvement | Evolution stores |
| Durable output | Task Results and durable artifact store |
| Execution location | Execution target store and immutable bindings |
| Active session execution | Core persisted session ownership; shared supervisor or an eligible foreground CLI/ACP owner |
| Task execution | Existing Task host/attempt leases plus executor-session ownership |
| Desktop connection | Main-owned bridge; no shared execution ownership |

Desktop-only read models include:

```ts
type WorkItemProjection =
  | SessionWorkItemProjection
  | TaskWorkItemProjection
  | ScheduledExecutionWorkItemProjection
  | EvolutionReviewWorkItemProjection;

type RunProjection =
  | SessionTurnRunProjection
  | TaskAttemptRunProjection
  | CronExecutionRunProjection;

type AttentionItemProjection =
  | ApprovalAttentionItem
  | InputAttentionItem
  | TrustAttentionItem
  | ProviderSetupAttentionItem
  | ConnectionAttentionItem
  | FailureAttentionItem
  | EvolutionReviewAttentionItem
  | DeliveryFailureAttentionItem;

type ModelRouteProjection = {
  providerId: string;
  modelId: string;
  role: "primary" | "fallback" | "auxiliary" | "session_override";
  runnable: boolean;
  credentialState: "not_required" | "missing" | "present" | "expired";
  diagnostics: SafeDiagnosticProjection[];
};

type ConnectionProjection = {
  channel: "telegram" | "discord" | "email" | "whatsapp";
  configurationState: string;
  runtimeState: string;
  authorizationState: string;
  availableActions: string[];
};
```

Renderer persistence is limited to layout, panel sizes, collapsed sections, and other non-authoritative display preferences.

## 7. Credential transaction model

Models and channels both collect secrets, so they share one explicit transaction boundary.

The [credential transaction decision](../architecture/desktop/credential-transactions.md) specifies transport, lifetime, cancellation and commit semantics. Existing setup writes are sequential, not proven crash-atomic across config and secret files; PR 6 must close that consistency/recovery gate and PR 8 must reuse it. The sequence below is a requirement, not a claim about current storage behavior.

```text
collect in isolated UI
→ stage in DesktopControlService memory
→ return opaque candidate ID
→ verify candidate directly
→ construct redacted setup draft
→ review
→ confirm
→ atomically apply secret/auth and config
→ discard candidate
→ read-only verification
```

Rules:

1. Credential candidates are profile-, purpose-, and window-bound.
2. Candidates have a short TTL and are single-use.
3. General event streams, request logs, diagnostics, Redux-style stores, browser storage, and crash reports never receive secrets.
4. The ordinary JSON-RPC channel receives candidate IDs, not credential values.
5. Raw credential submission uses a separate, non-logged pipe owned by Electron Main and the service.
6. The service response says only `candidate accepted`, `credential present`, or a bounded validation error.
7. Before the apply commit boundary, cancel, timeout, profile switch, service shutdown, failed review, and blocked apply discard candidates and write nothing. After commit begins, reconcile the outcome; do not claim nothing was saved. Post-apply verification is read-only and does not roll back a successful save silently.
8. JavaScript cannot guarantee memory zeroization; the implementation must drop references promptly and make no stronger claim.
9. OAuth runs entirely in the service. The renderer receives verification URL, user code, expiry, and safe status only.
10. Successful OAuth tokens remain staged until the reviewed Apply step writes profile-local `auth.json`.
11. A compromised renderer could observe text while the user types it. Use a dedicated local-only credential window, disable production DevTools, load no remote content, and document this limit honestly.

## 8. Control protocol

### 8.1 Initialization

This is the planned Desktop transport. Current private host control uses an authenticated single-request v1 envelope, not JSON-RPC or capability negotiation; see the [compatibility decision](../architecture/desktop/decisions.md#adr-d-002--preserve-existing-host-wire-v1-add-desktop-transport-explicitly). PRs 2–3 must provide validated adapters and coordinate any missing host generation contracts before advertising dependent mutations. PR 1 preserves host wire behavior.

The first request is `control.initialize`, carrying protocol version, client version, selected profile, and supported capabilities. A major mismatch fails initialization. Minor differences use capability negotiation.

Every mutation carries an `operationId` with the request binding, durable receipt, conflict, expiry, and uncertain-outcome behavior in the [shared control contract](workspace-execution-ownership-decisions.md#inputs-and-idempotency). Every execution-target-sensitive operation carries the core target ID and expected generation. Owner fences and authenticated principal context are resolved by trusted core code, not accepted as authority from renderer fields.

### 8.2 Method groups

```text
control.initialize
control.bootstrap
control.subscribe
control.unsubscribe

profiles.list
profiles.use

work.list
work.get
work.activity

sessions.create
sessions.resume
sessions.send
sessions.cancelTurn

tasks.get
tasks.pause
tasks.resume
tasks.cancel
tasks.retry
tasks.guide
tasks.results

inbox.list
approvals.resolve

providers.list
providers.get
providers.diagnostics
models.list
models.refresh
models.testCandidate
modelRoutes.get
modelRoutes.createDraft
modelRoutes.review
modelRoutes.apply
modelRoutes.verify
oauth.start
oauth.status
oauth.cancel
fallbacks.list
fallbacks.createDraft
fallbacks.reorderDraft
fallbacks.apply
auxiliaryRoutes.list
auxiliaryRoutes.createDraft
auxiliaryRoutes.apply
sessionModelOverride.get
sessionModelOverride.set
sessionModelOverride.clear

connections.list
connections.get
connections.createDraft
connections.review
connections.apply
connections.verify
connections.enable
connections.disable
telegram.test
telegram.pairing.create
telegram.pairing.cancel
telegram.commands.sync
telegram.testMessage
gateway.status
gateway.install
gateway.start
gateway.stop
gateway.restart
gateway.diagnose
handoff.create
handoff.revoke
handoff.list

executionTargets.list
executionTargets.createWorktree
executionTargets.verify
executionTargets.archive

files.list
files.read
diff.get
terminal.create
terminal.resize
terminal.close

artifacts.list
artifacts.get
artifacts.open
evidence.get

browser.sessions
browser.snapshot
browser.control.acquire
browser.control.release
browser.input

schedules.list
schedules.get
```

Unavailable methods are omitted from advertised capabilities.

### 8.3 Safe notifications

```text
control.ready
assistant.delta
assistant.completed
plan.changed
tool.started
tool.progress
tool.completed
approval.requested
approval.resolved
task.changed
work.changed
attention.changed
provider.changed
modelRoute.changed
oauth.changed
connection.changed
gateway.changed
handoff.changed
artifact.changed
evidence.changed
usage.changed
service.warning
service.shutdown
```

Notifications carry subscription ID, stream ID, sequence, timestamp, type, and a bounded safe payload. Raw runtime events, provider bodies, tool arguments, secrets, OAuth tokens, raw channel payloads, and unreviewed paths never cross this boundary.

### 8.4 Reconnection

- Sequence numbers are scoped to service instance and stream.
- Main retains the latest delivered sequence.
- Reconnect requests events after that sequence.
- A restarted service or expired bounded buffer returns `snapshot_required`.
- The client fetches canonical snapshots and resumes from the new cursor.
- Raw runtime events are never treated as a durable replay log.
- Bridge restart and supervisor restart are distinct: a bridge restart must not reclaim or restart Work. Reconcile outstanding operation receipts before resubmitting mutations. Bind snapshot acquisition to a cursor boundary and resync on a gap; preserve a bounded priority path for cancel/deny while streaming output is backpressured.

## 9. Display status model

Do not add a new backend lifecycle. Normalize canonical states into:

```ts
type WorkDisplayStatus =
  | "draft"
  | "queued"
  | "running"
  | "needs_attention"
  | "paused"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
```

`waiting_for_host` displays as queued with a reason. `waiting_for_input` and `waiting_for_approval` display as needs attention. Existing Task contracts remain canonical.

## 10. Milestone plan

### Milestone 0 — Architecture and security baseline

Deliver:

- architecture decision records
- renderer/control-service/channel/provider threat model
- protocol method and event catalog
- canonical ownership matrix
- credential transaction design
- alpha scope and exclusions
- UX information architecture
- accessibility and Arabic/RTL requirements
- packaging decision record

Exit when maintainers approve authority boundaries and secret handling.

Adopt the shared ownership decision and implementation dependency map before adding target or scheduler code. Make an early packaged bridge/supervisor launch-and-reconnect proof part of this milestone; final signing/hardening remains in the release milestone.

### Milestone 1 — Protocol package and service skeleton

Implement:

- versioned envelopes and validators
- JSON-RPC parser/writer
- request cancellation
- bounded subscriptions
- graceful shutdown
- profile-bound bootstrap
- dedicated credential pipe
- fake-runtime integration harness
- internal command `estacoda desktop-service --stdio --profile <id>`
- supervisor client discovery, authenticated connection, and capability/version checks using workspace PR 4's host-control endpoint

Reuse parsing concepts from ACP but not ACP session or permission behavior.

Exit when malformed/oversized messages fail safely, stdout remains NDJSON, credentials never enter control logs, and no request crosses profiles.

### Milestone 2 — Safe projections and runtime controls

Build Work and Activity projections from Sessions, Tasks, Cron executions, approvals, usage, Results, and safe runtime events.

Grouping rules:

- an interactive session is a root Work item
- Tasks created by it appear as children/runs
- independently created Tasks are root Work items
- Cron executions are children of schedules

Wire session start/resume/send/cancel and Task pause/resume/cancel/retry/guidance/result inspection through existing owners.

Route shared execution through the supervisor's session host and core coordinator. Do not instantiate a second agent runtime or scheduler in the bridge. Real Work execution depends on workspace PRs 0–4; fake-runtime projection development may precede them.

Exit when CLI behavior is unchanged and restart reconstructs the same projection from canonical state.

### Milestone 3 — Durable desktop approvals and Inbox

Add `desktop` as a local approval surface. Bind approvals to exact profile, session, Task/Attempt where relevant, risk class, tool, and target fingerprint. Alpha exposes approve once and reject only.

Inbox projects:

- approvals
- input requests
- uncertain-side-effect review
- failed/partial Tasks
- missing model route or credential
- provider authorization expiry
- channel/gateway problems
- trust/setup blockers
- failed schedules
- Evolution proposals
- delivery failures

The backend calculates available actions.

For channel approvals, the bridge invokes the supervisor's `ChannelGateway` local operator method. Local Task approvals use the existing Task approval/controller path. The queue is canonical storage; Desktop never becomes a second continuation or grant orchestrator.

Exit when approval survives app restart and forged, duplicate, cross-session, and cross-profile resolutions fail closed.

### Milestone 4 — Secure Electron shell and approved interface

Implement secure BrowserWindow policy, service supervision, reconnecting protocol client, semantic preload methods, profile bootstrap, recovery screens, layout, keyboard navigation, and bidi-safe rendering.

Implement the complete [approved visual contract](desktop-visual-contract.md) as reusable React components: official branding, semantic themes, navigation/search/pinning, composer and Work states, Inbox, inspector, Models/Appearance, Library, Connections, and background-work views. Use deterministic fixtures through the same view-model boundary for integrations not yet delivered. Fixture mode is isolated from live services and excluded from release entry points. Appearance preferences can be live in this milestone; runtime-affecting configuration retains reviewed apply paths.

Deny unexpected navigation, windows, and permissions. Enforce CSP. Do not embed remote content in privileged frames.

Exit when renderer compromise does not provide Node/filesystem access, service death produces a recoverable state, and every required [visual/interaction acceptance case](desktop-design/acceptance-matrix.md) has review evidence. A secure but generic shell does not satisfy this milestone. Live features still follow the delivery mapping in the visual contract.

### Milestone 5 — Models and Providers

This milestone is required before Desktop can create new Work for an unconfigured profile.

#### Provider dashboard

Show each provider as not configured, credential required, authorization expired, configured, ready, unreachable, invalid credential, model unavailable, catalog only, or unsupported.

Use provider metadata to distinguish catalog visibility, configurability, and runnability. Do not make catalog-only routes selectable.

#### API-key setup

Flow:

1. Select a configurable provider.
2. Select or enter a model.
3. Stage an API key.
4. Review endpoint and API mode.
5. Optionally run a minimal candidate verification with an explicit spend notice.
6. Choose primary, fallback, or specialist role.
7. Review the redacted change.
8. Confirm and apply.
9. Verify persisted state read-only.

The selected profile `.env` receives the key only during Apply. Config stores only the environment-variable reference.

#### Codex OAuth

Run OAuth device PKCE in the service:

```text
start authorization
→ show verification URL and user code
→ open browser on explicit action
→ poll in service
→ verify candidate route
→ review
→ apply tokens to profile auth.json
```

Profile switch, cancellation, timeout, and service shutdown discard staged authorization.

#### Local/custom endpoints

Support the built-in local provider and named OpenAI-compatible endpoints with reviewed URL, authentication (`none` or `api_key`), API mode, model ID, network enablement, context override, and output cap.

Do not expose arbitrary provider headers in alpha; they need a separate secret-reference design.

#### Model catalog

Provide offline-first browsing with provider, model ID, runnable/configured status, context, output limit, tool/vision support, pricing availability, retired status, and metadata source. Live refresh is explicit.

#### Primary, fallback, and specialist routes

- One primary route per profile.
- Ordered fallbacks with add/remove/reorder/test.
- Reject duplicates and a fallback identical to primary.
- Expose reviewed specialist slots: assessor, compression, session search, memory compaction, and profile context.
- Keep Vision in capability settings because of hosted-processing/privacy policy.
- Do not expose all internal auxiliary task names merely because they exist in the contract.

#### Per-Work override

A Work-specific model selection is session/Task-scoped. It does not mutate profile defaults. A separate explicit action may propose setting it as the profile default.

#### Verification and diagnostics

Report endpoint reachability, credential acceptance, model acceptance, streaming/tool compatibility when tested, latency, safe finish reason, usage, and price availability. Tests do not enter transcripts, memory, or Evolution.

Exit when API-key, Codex OAuth, and no-auth local routes can be configured without CLI; cancellation writes nothing; failed setup preserves the prior primary route; fallbacks persist; overrides stay local; and secrets remain profile-isolated.

### Milestone 6 — Core Work experience

New Work selects profile, trusted workspace or target, model route, objective, optional limits, and interactive session or durable Task. Advanced budget and authority live in a review drawer.

Active Work includes conversation, plan, tool trail, child Tasks, approvals, status, cost/context, and outcome. Actions are capability-driven: send, guide, cancel turn, pause/resume Task, retry, approve once, reject, and inspect result.

Do not display fake controls; for example, an ordinary active turn is cancellable but not necessarily pausable.

Exit when one trusted workspace completes Work, delegated Tasks survive restart, activity is correctly interleaved, and a per-Work model override does not mutate the profile.

### Milestone 7 — Connections and Telegram

Telegram is included in alpha as EstaCoda's strongest live-proven first-party remote channel. Discord and Email may appear with accurate validation status later. WhatsApp remains explicitly experimental with account-risk disclosure.

#### Connections dashboard

Separate configuration and process state:

```text
Telegram
Configuration  Ready
Authorization  2 users, 1 group
Gateway        Running
Last verified  4 minutes ago
```

States include disabled, credential missing, authorization missing, pairing pending, ready, starting, running, stopped, degraded, and invalid configuration.

#### Telegram setup

Flow:

1. Explain BotFather bot creation.
2. Stage the bot token through the credential pipe.
3. Verify it without persisting.
4. Configure an allowlist or explicit pairing policy.
5. Configure normal channel behavior.
6. Review a redacted setup draft.
7. Confirm and apply token/config.
8. Explicitly install/start the gateway if requested.
9. Verify token, authorization, process liveness, polling, and optional test delivery.

Recommended default authorization is allowlist. Let users add Telegram user IDs and group/chat IDs. Pairing codes are short-lived and one-use. The adapter remains denied by default without allowlist, pairing, or an explicitly reviewed open policy; alpha need not expose open policy.

Default behavior:

- protected-handoff secure input
- streaming enabled
- queue-based busy behavior
- current group/thread session defaults
- bounded attachment and debounce settings

Advanced settings may expose poll timeout, queue depth, debounce, text coalescing, and streaming edit policy. Direct-DM secret capture carries an explicit warning that Telegram already received the value and deletion is best-effort.

#### Gateway lifecycle

Expose install, start, stop, restart, status, and diagnose as explicit actions. Configuration readiness must not be presented as proof that the gateway process is alive.

#### Remote interaction

Authorized Telegram messages create or resume canonical sessions and appear as Work with safe origin metadata. Show Tasks, approvals, usage, artifacts, delivery state, and result without creating a parallel Telegram transcript store.

#### Handoff

From Desktop, generate a short-lived code and instruct the user to send `/attach <code>` to the bot. Display attached surfaces and allow revoke/detach. Telegram-originated sessions are openable in Desktop under the same authorization rules.

Both views attach to the same supervisor-owned session; displaying/attaching a surface never transfers execution ownership. Foreground CLI/ACP sessions require the settled-boundary transfer in the shared decision before shared continuation is acknowledged. Detaching a surface revokes that attachment, not unrelated Work or another surface's authority.

#### Approvals

Telegram buttons and Desktop cards are views over the same durable approval. `ChannelGateway` performs resolution. A decision on one surface updates the other.

#### Operations

Support allowlist editing, pairing creation/cancel, token rotation, enable/disable, gateway control, command sync, test message, attached-session inspection, queue pressure, delivery failures, and redacted diagnostics.

Disconnect offers separate disable and remove flows. Credential deletion requires an additional explicit confirmation.

Exit when setup requires authorization, raw tokens never appear in config/UI/logs/events, messages map to the correct session, unauthorized senders are rejected, approvals synchronize across surfaces, handoff survives restart, and profiles cannot see each other's channel state.

### Milestone 8 — Execution targets and worktrees

Consume the profile-owned local target records and bindings delivered by workspace PR 1. Extend that same core target implementation with a managed Git worktree variant carrying repository identity and creation/cleanup ownership. Do not add another workspace registry or redefine the source/working-root relationship.

Sessions and Tasks already reference core target IDs while retaining their actual working-root path/hash as compatibility snapshots. For a worktree, those fields describe the worktree, not the source checkout. A source alias move never retargets existing work. Generation changes invalidate stale operations but do not independently authorize replacement or force repeated approval.

Every target operation supplies target ID and expected generation. The service rechecks profile, canonical root, repository identity, trust, ownership, and readiness.

Use `git` argument arrays with `shell: false`. Support inspect, list, create, verify, dirty-state inspection, and safe archive. Do not force-remove dirty worktrees in alpha.

Creating a worktree from a trusted repository does not silently trust the new path. Include explicit trust in the reviewed creation flow.

Exit when agent tools, files, diff, terminal, and browser cannot disagree on target and stale/moved/cross-profile targets fail closed.

### Milestone 9 — Files, diff, and terminal

Files begin read-only with bounded listing/preview, binary metadata, traversal/symlink protection, size limits, and truncation.

Diff returns structured changed-file, staged/unstaged, patch, binary, and rename data. Never execute a renderer-supplied Git command.

Terminal uses a Main-owned ephemeral PTY with a separately owned, verified target capability from core. Close it on window/profile change or loss of the verified control connection. Shared agent command processes remain environment/scope-owned. Terminal input is not approval, and a renderer API cannot establish human provenance merely by naming its input human. `cwd` is not filesystem confinement. Output is not copied into model transcripts or persisted unless explicitly captured as an artifact.

Exit when traversal, symlink, stale-target, and process-tree shutdown tests pass.

### Milestone 10 — Durable artifacts and Evidence

Extend existing profile-owned artifact retention, hydration, digest verification, and Task Results. Add the broader metadata/projections needed for managed copies, target-scoped workspace references, and sanitized external references. Persist digest, MIME, size, display name, ownership links, retention, and evidence links through shared core paths. Do not expose backing paths by default or create duplicate Desktop artifact ownership.

Build Evidence from actual allowed tool executions, Results, diagnostics, artifacts, and final outcomes. Distinguish claimed completion, observed mutation, compatible validation, failure, unverified mutation, and limitation. Agent prose may explain but never manufacture verified status.

Exit when artifacts survive restart, digests are checked, cross-profile reads fail, and missing verification displays unverified.

### Milestone 11 — Browser view

Alpha lists existing browser sessions and displays bounded screenshot/state, current URL, navigation state, and artifacts. Do not expose raw CDP or embed privileged remote webviews.

Exit when URL policy remains authoritative and browser credentials never cross to the renderer.

### Milestone 12 — Browser human takeover

Beta adds a fenced control lease owned by agent or desktop human. Agent actions and human input verify the current generation. Acquisition pauses new agent actions; release explicitly returns control.

Exit when concurrent/stale control fails and cloud-spend/private-URL policies remain enforced.

### Milestone 13 — Governed settings, Library, memory, skills, and Evolution

Use the reviewed setup/apply path for profile, trust, security, browser, voice, optional capabilities, and diagnostics. Models and Connections reuse the same review machinery but retain their dedicated UX.

Library exposes skills, memory, artifacts, Evidence, and Evolution proposals. Evolution promotion remains explicit, reviewable, reversible, and gated.

### Milestone 14 — Scheduling

Expose existing once, interval, and Cron schedules; history; delivery; failure; enable/disable; and run now. Editing reviews profile, target, objective, model, authority, spend, delivery, next run, and failure behavior.

Event subscriptions are later and require at least two real sources plus connector auth, signature validation, replay protection, deduplication, idempotency, target/profile binding, budgets, and escalation.

### Milestone 15 — Packaging and hardening

Start with macOS, then Windows after PTY and service lifecycle stabilize. Deliver signing, notarization, reproducible metadata, native-module rebuild, packaged sidecar discovery, crash recovery, redacted diagnostics, accessibility, keyboard navigation, Arabic/RTL verification, upgrade compatibility, and clean uninstall behavior.

Do not enable Electron auto-update in alpha until ownership is reconciled with EstaCoda lifecycle policy.

## 11. Alpha scope

Include:

- secure Electron shell and profile-bound service
- model provider dashboard
- API-key provider setup
- Codex OAuth setup
- local/custom endpoint setup
- primary route, fallback chain, reviewed specialist routes
- per-Work model override
- one selected profile per window
- trusted local workspace and app-managed worktree
- new/resumed sessions and durable Tasks
- streaming, tools, plans, child agents, and usage
- approve once/reject, guide, pause/resume where supported, cancel, retry
- Inbox
- Telegram setup, allowlist/pairing, gateway lifecycle, handoff, approvals, and diagnostics
- files, Git diff, and integrated terminal
- durable artifacts and Evidence
- restart recovery
- browser view-only
- read-only schedule list/history
- signed macOS package

Exclude:

- containers and remote environments
- organization/RBAC control plane
- generic webhooks and event subscriptions
- desktop-wide computer control
- arbitrary plugins
- full code editor
- persistent approve-always from Desktop
- force deletion of dirty worktrees
- arbitrary secret-bearing provider headers
- automatic updates
- multiple profiles in one service process
- claiming catalog-only providers are runnable
- WhatsApp without explicit experimental/account-risk gating

## 12. Test strategy

### Protocol and process

- version compatibility
- malformed/oversized frames
- duplicate IDs and cancellation
- sequence gaps and snapshot recovery
- service restart and shutdown
- capability negotiation
- stdout purity
- bounded errors
- dedicated credential pipe exclusion from protocol logs
- one supervisor across concurrent windows; private endpoint authentication and incompatible-host rejection
- bridge restart versus host restart; no duplicate session owner or channel poller
- lost-response receipts, control priority during output floods, and ownership loss during sleep

### Credential and setup transactions

- cancellation writes nothing
- blocked apply writes nothing
- candidate TTL and single use
- candidate/profile/window/purpose binding
- profile switch discards candidates
- raw keys/tokens absent from config, snapshots, logs, diagnostics, events, and crash export
- OAuth cancellation/expiry/restart
- successful apply writes only to selected profile

### Models and providers

- visibility/configurability/runnability distinctions
- API-key route setup
- Codex OAuth route setup
- no-auth local route
- custom endpoint validation
- failed candidate leaves primary unchanged
- duplicate/primary fallback rejection
- fallback ordering
- public auxiliary-slot restriction
- Work override is non-persistent
- verification does not enter transcript/memory/Evolution
- safe provider errors and cost reporting

### Connections and Telegram

- token verification without persistence
- allowlist or pairing required
- unauthorized sender rejection
- user/chat/topic session scoping
- gateway ready versus running
- install/start/stop/restart behavior
- pairing expiry and replay rejection
- command sync and test delivery
- handoff attach/detach/revoke
- approval synchronization across Telegram/Desktop
- token rotation and disable/remove separation
- cross-profile channel/session/credential isolation
- secure-input mode behavior

### Projections and security

- Task status mapping and Work grouping
- no duplicate Work
- Inbox ordering and backend actions
- cross-profile/session approval rejection
- hardline denial
- trust changes
- target generation and identity mismatch
- path traversal and symlink escape
- dirty cleanup refusal
- renderer navigation/permission denial
- path and secret exclusion
- browser lease fencing

### Persistence and migration

- target/artifact schema migration and backup
- rollback on migration error
- compatibility workspace bindings
- foreign-key enforcement
- profile isolation
- existing CLI behavior unchanged

### Desktop end-to-end journeys

1. Launch an unconfigured profile and add an API-key provider.
2. Configure Codex OAuth and confirm tokens remain profile-local.
3. Configure a local no-auth endpoint.
4. Select primary/fallback routes and start Work.
5. Override one Work's model without changing the profile.
6. Stream a turn, execute tools, approve, and complete.
7. Configure Telegram with token and allowlist.
8. Start gateway and receive an authorized Telegram message as Work.
9. Reject an unauthorized Telegram sender.
10. Resolve approval on Telegram and observe Desktop update; repeat in reverse.
11. Attach a Desktop session through Telegram handoff.
12. Restart app/gateway and recover mappings and Work.
13. Create a worktree and inspect files/diff/terminal.
14. Close during a durable Task and reopen to completion.
15. Verify failed validation displays failed/unverified Evidence.
16. Switch profiles and confirm previous model/channel/work state disappears.

Apply the [shared conformance matrix](workspace-execution-ownership-decisions.md#7-required-conformance-cases). In journey 16, previous shared Work keeps running under its original profile; only its visibility and client handles disappear. Journey 14 must work with Desktop fully quit, and its background-host/service prerequisites must be visible.

### Validation commands

Retain the repository validation suite and add:

```bash
pnpm run desktop:typecheck
pnpm run desktop:test
pnpm run desktop:e2e
pnpm run desktop:package
```

Do not claim a full validation pass unless every configured command was actually run.

### Visual and interaction regression gate

PR 5 adds deterministic captures and interaction checks from the [approved design acceptance matrix](desktop-design/acceptance-matrix.md) to `desktop:e2e`, with a documented focused visual invocation. Capture and manually review the frozen reference against the React implementation before accepting the first golden images. Compare identical viewports, fonts, appearances, device scales, and fixture states; test light/dark, theme changes, keyboard access, zoom, mixed-direction text, and recovery. Keep this gate in later UI PRs. Do not silently update baselines to accept visual drift. These commands and screenshot baselines are planned additions, not existing validation results.

## 13. Commit and PR structure

Deliver milestone PRs rather than one long-lived implementation branch. Every commit must compile and pass relevant tests. Preserve security-boundary commits during review instead of squashing them into unrelated UI work.

### PR 1 — Architecture and workspace foundation

Implementation baseline: [Desktop architecture foundation](../architecture/desktop/README.md). PR 1 records decisions and registers the minimal shared package; the executable bridge/supervisor and packaged lifecycle proof require PRs 3–5. No Electron or service implementation is implied by these documentation commits.

- `docs(desktop): define product scope and canonical ownership`
- `docs(desktop): add renderer service provider and channel threat model`
- `docs(desktop): define credential transaction and secret boundaries`
- `docs(desktop): record protocol and process decisions`
- `chore(workspace): register desktop against the shared core control protocol package`

### PR 2 — Control protocol

- `feat(control-protocol): add versioned JSON-RPC envelopes`
- `feat(control-protocol): define bootstrap and capabilities`
- `feat(control-protocol): define work activity inbox model and connection projections`
- `feat(control-protocol): add bounded runtime validators`
- `test(control-protocol): cover compatibility and malformed messages`
- `docs(control-protocol): document methods events and reconnect semantics`

### PR 3 — Desktop control service

- `feat(control-service): add profile-bound stdio server`
- `feat(control-service): connect to the existing supervisor control endpoint`
- `feat(cli): expose internal desktop-service command`
- `feat(control-service): add initialization and bootstrap snapshots`
- `feat(control-service): add dedicated credential candidate pipe`
- `feat(control-service): project safe runtime notifications`
- `feat(control-service): add bounded subscriptions and resync`
- `test(control-service): cover shutdown restart credentials and profile isolation`

### PR 4 — Work, Tasks, approvals, and Inbox

- `feat(control-service): add session work projections`
- `feat(control-service): add task and run projections`
- `feat(control-service): add session lifecycle methods`
- `feat(control-service): expose task lifecycle and guidance controls`
- `feat(approvals): add durable desktop approval surface`
- `feat(inbox): project approvals setup waits and failures`
- `test(control-service): cover work grouping and status mapping`
- `test(approvals): reject forged and cross-session resolutions`

### PR 5 — Secure Electron shell and approved interface

Required inputs: [visual contract](desktop-visual-contract.md), [frozen reference and assets](desktop-design/README.md), and [acceptance matrix](desktop-design/acceptance-matrix.md). Deliver the complete approved appearance and fixture journeys in this PR, with live bootstrap/inspection proof. The sequence expands from 9 to 15 focused commits to make the design work and verification explicit.

- `chore(desktop): scaffold Electron Forge Vite and React`
- `feat(desktop-main): enforce secure window policy`
- `feat(desktop-main): supervise the control-service process`
- `feat(desktop-main): add reconnecting protocol client`
- `feat(desktop-main): add isolated credential submission path`
- `feat(desktop-preload): expose narrow semantic APIs`
- `feat(desktop-ui): add approved brand assets semantic tokens and primitives`
- `feat(desktop-ui): add Kemet Graphite Sand and appearance preferences`
- `feat(desktop-ui): add approved sidebar search pinned work and navigation`
- `feat(desktop-ui): add approved composer work inbox and inspector views`
- `feat(desktop-ui): add library connections and background fixture views`
- `feat(desktop-ui): add models appearance and setup fixture journeys`
- `feat(desktop-ui): add profile bootstrap and recovery states`
- `test(desktop-ui): verify approved visuals interactions and accessibility`
- `test(desktop): cover preload exposure window policy and credential isolation`

Dependency and lockfile changes stay in the scaffold or feature commit that requires them. Introduce the isolated fixture adapter alongside its first consumer; later features reuse these components. The visual-test commit includes reviewed reference/React comparisons, capture metadata, and documented deviations. The source prototype remains frozen. Missing production brand quality, unexplained visual drift, or fixture calls reaching live services blocks PR 5 completion.

### PR 6 — Models and Providers

Connect the PR 5 Settings/Models and composer components to live route/setup services. Preserve their approved appearance and rerun the visual gate; do not create a second dashboard design.

- `feat(control-service): expose provider metadata and model catalog`
- `feat(control-service): project route health and credential presence`
- `feat(control-service): add bounded candidate route verification`
- `feat(control-service): expose reviewed primary route apply`
- `feat(control-service): expose fallback route management`
- `feat(control-service): expose reviewed auxiliary routes`
- `feat(control-service): expose session model overrides`
- `feat(control-service): bridge Codex OAuth device authorization`
- `feat(desktop-models): add provider and model dashboard`
- `feat(desktop-models): add API-key provider setup`
- `feat(desktop-models): add Codex OAuth setup`
- `feat(desktop-models): add local and custom endpoint setup`
- `feat(desktop-models): add primary fallback and specialist editors`
- `feat(desktop-work): add session-scoped model picker`
- `test(model-setup): preserve secrets and profile isolation`
- `test(model-routes): cover primary fallback auxiliary and override behavior`
- `test(desktop-models): cover cancellation verification and recovery`
- `docs(desktop): document provider and model management`

### PR 7 — Core Work experience

Connect the approved Work, Inbox, search, pin references, composer, and runtime-count views to canonical projections. Extend the narrow protocol/Main API for bounded search and validated attachments if not already supported; include profile/target fencing and payload limits. No filename-only mock may count as live attachment submission.

- `feat(desktop-work): add work list and detail routing`
- `feat(desktop-work): connect bounded search and profile-scoped pin references`
- `feat(desktop-work): add validated target-scoped attachment submission`
- `feat(desktop-work): stream assistant and tool activity`
- `feat(desktop-work): render plans tasks and child agents`
- `feat(desktop-work): add lifecycle guidance and model controls`
- `feat(desktop-approvals): add approve-once and reject cards`
- `feat(desktop-inbox): add needs-attention workflow`
- `feat(desktop-usage): show canonical cost context usage and runtime counts`
- `test(desktop-work): cover live task attachment search approval override and restart journeys`

### PR 8 — Connections and Telegram

Connect the PR 5 Connections components to real readiness, authorization, and gateway projections. The Email fixture is not alpha scope or proof of a supported connection. Retain the approved visual gate.

- `feat(control-service): project channel readiness and gateway liveness`
- `feat(control-service): expose reviewed Telegram setup drafts`
- `feat(control-service): add Telegram candidate verification`
- `feat(control-service): expose gateway lifecycle and diagnostics`
- `feat(control-service): expose Telegram pairing command sync and testing`
- `feat(control-service): expose channel sessions and handoff`
- `feat(desktop-connections): add Connections dashboard`
- `feat(desktop-telegram): add bot and authorization setup`
- `feat(desktop-telegram): add review apply and verification`
- `feat(desktop-telegram): add status and gateway controls`
- `feat(desktop-telegram): add pairing testing and handoff`
- `test(connections): protect credentials and profile boundaries`
- `test(telegram): cover authorization pairing approvals and restart`
- `test(desktop-telegram): cover setup cancellation and operations`
- `docs(desktop): document Telegram setup interaction and recovery`

### PR 9 — Execution targets

- `feat(control-service): project shared core target contracts and bindings`
- `feat(execution-targets): extend core targets with managed Git worktree provenance`
- `feat(worktrees): implement creation and verification`
- `feat(worktrees): add safe archive and dirty refusal`
- `feat(control-service): expose target lifecycle`
- `feat(desktop-worktrees): add target selection and creation`
- `test(execution-targets): cover identity fencing and profile isolation`
- `test(worktrees): cover trust ownership and cleanup`
- `docs(desktop): document worktree trust and recovery`

### PR 10 — Files, diff, and terminal

- `feat(control-service): add bounded target-scoped file reads`
- `feat(desktop-files): add tree and preview`
- `feat(control-service): add structured Git diff`
- `feat(desktop-diff): add changed-file and patch views`
- `build(desktop): add PTY and terminal dependencies`
- `feat(desktop-terminal): add target-scoped PTY lifecycle`
- `test(files): block traversal symlink and stale-target access`
- `test(desktop-terminal): cover shutdown and target fencing`

### PR 11 — Artifacts and Evidence

- `feat(artifacts): extend shared profile-owned artifact metadata`
- `feat(artifacts): extend existing managed content retention for desktop consumers`
- `feat(artifacts): link sessions tasks and attempts`
- `feat(evidence): project verified execution evidence`
- `feat(control-service): expose artifact and evidence methods`
- `feat(desktop-evidence): add completion and evidence views`
- `feat(desktop-library): connect artifact browse preview and source work links`
- `test(artifacts): cover integrity retention and isolation`
- `test(evidence): distinguish verified partial and unverified outcomes`
- `docs(desktop): document artifact and evidence guarantees`

### PR 12 — Browser view

- `feat(control-service): project browser session state`
- `feat(control-service): expose bounded browser snapshots`
- `feat(desktop-browser): add view-only browser surface`
- `test(desktop-browser): cover URL policy and renderer isolation`

### PR 13 — Browser takeover

- `feat(browser): add fenced control lease`
- `feat(browser): gate agent actions on ownership`
- `feat(control-service): expose human control acquisition`
- `feat(desktop-browser): forward leased pointer and keyboard input`
- `test(browser): cover concurrent control and stale lease rejection`
- `docs(browser): document takeover security model`

### PR 14 — Governed settings and Library

Connect and extend the existing PR 5 Settings and Skills & tools components; retain the approved navigation and theme system. Governed runtime configuration stays separate from local appearance preferences.

- `feat(control-service): expose reviewed configuration drafts`
- `feat(desktop-settings): add summary confirm apply verify flow`
- `feat(control-service): project skills memory and evolution state`
- `feat(desktop-library): add skills memory artifact and evidence views`
- `feat(desktop-evolution): add proposal review controls`
- `test(desktop-settings): prevent cancellation and blocked-apply writes`

### PR 15 — Scheduling

Connect the approved status-strip scheduling entry and background-work views to canonical Cron projections. Unknown/disconnected state must not display fixture counts or imply that a scheduled run is active.

- `feat(control-service): expose schedule and execution projections`
- `feat(desktop-scheduled): add schedule list and history`
- `feat(desktop-scheduled): add reviewed schedule editor`
- `feat(desktop-scheduled): add run-now enable and disable actions`
- `test(desktop-scheduled): cover profile target model and delivery binding`

### PR 16 — Packaging and release hardening

- `build(desktop): add macOS packaging and native-module rebuild`
- `build(desktop): add signing and notarization configuration`
- `ci(desktop): add typecheck test and package jobs`
- `test(desktop): add packaged application smoke journeys`
- `feat(desktop): add redacted diagnostic export`
- `docs(desktop): add installation recovery and known limitations`
- `chore(release): define desktop alpha release checklist`

## 14. Release checkpoints

### Architecture proof

After PR 5:

- secure app launches
- service connects and recovers
- profile isolation is proven
- existing Work is inspectable
- credential staging is isolated; provider visual journeys are complete with fixtures, while live provider setup remains PR 6
- all approved interface states have reviewed visual and interaction evidence against the frozen reference
- Kemet/Graphite/Sand and Light/Dark/System work without losing draft or attachment state
- fixture mode is isolated from runtime operations and absent from release entry points

### Usable internal prototype

After PR 7:

- a new user can configure a model
- primary/fallback routes work
- Work can be started and supervised
- approvals and restart recovery work

### Internal alpha

After PR 10:

- Telegram setup and remote interaction
- Worktrees
- files, diff, and terminal
- model and channel diagnostics

### External alpha

After PR 12 and PR 16:

- durable artifacts and Evidence
- view-only browser
- signed macOS package
- E2E security and recovery coverage

### Beta

After browser takeover, governed Library/settings, and scheduling.

Remote environments, event subscriptions, organization controls, and general plugin management are post-beta programs.

## 15. Estimated schedule

For two experienced engineers, one core/runtime and one Electron/frontend:

These provisional estimates must be revisited after workspace PRs 0–4 and the packaged ownership proof. They also require re-estimation for the expanded PR 5 visual implementation and regression gate; the original totals below are historical planning ranges, not a renewed delivery commitment. They do not include delivering those shared runtime prerequisites with the same engineers. The small proof below intentionally precedes the full Models/Connections alpha scope.

| Work | Estimate |
|---|---:|
| Architecture, protocol, service, approvals | 3–4 weeks |
| Secure shell and Models/Providers | 3–4 weeks |
| Core Work and Telegram Connections | 3–4 weeks |
| Targets, worktrees, files/diff/terminal | 3–4 weeks |
| Artifacts, Evidence, browser view | 2–3 weeks |
| Packaging, E2E, security hardening | 2–3 weeks |
| External-quality alpha | **16–22 weeks** |

For one experienced engineer, expect approximately **28–38 weeks**. Browser takeover, complete governed settings, schedule editing, Windows packaging, and post-alpha capabilities extend beyond this estimate.

## 16. Immediate implementation slices

Prerequisite: workspace PRs 0–4 deliver shared local targets, host leases, session ownership, and supervisor control. Build a small packaged proof with an existing configured profile before committing to the complete Desktop alpha. Docker, managed worktrees, and provider-setup UI are not prerequisites for that proof. Workspace PR 5 and Slice C then establish channel continuation before the workspace Docker/copy release work.

### Slice A — Architecture proof

```text
Electron launches
→ Main starts profile-bound DesktopControlService
→ bridge connects to one independently running profile supervisor
→ renderer receives safe bootstrap
→ service projects an existing Session and Task
→ a durable approval appears
→ user resolves it
→ bridge restarts while the same supervisor retains execution ownership
→ supervisor restarts through the owned lifecycle and reconciles pending effects
→ canonical state is reconstructed
```

### Slice B — Setup-to-Work proof

```text
open unconfigured profile
→ stage provider credential
→ verify candidate
→ review and apply primary route
→ attach trusted local workspace
→ start Work
→ stream assistant and tools
→ complete with usage and outcome
→ restart and recover
```

### Slice C — Telegram proof

```text
stage Telegram token
→ verify bot
→ configure one allowed user
→ review and apply
→ start gateway
→ receive authorized message
→ map it to Work
→ request approval
→ resolve from Desktop
→ deliver continuation to Telegram
→ quit Desktop while shared work remains active
→ resolve a later approval from Telegram
→ reopen Desktop and observe the same owner/history
→ restart and recover mapping
```

Complete these slices before managed worktree lifecycle, PTY integration, broader artifact storage, or browser control. They validate the highest-risk boundaries early while reusing existing artifact retention.

## 17. Implementation hygiene

The operator checkout contains unrelated untracked duplicate-looking files. Desktop commits must stage explicit task-owned paths and leave unrelated content alone. When those files affect TypeScript discovery, validate a clean temporary copy of the tracked tree plus explicitly reviewed new files. Desktop commits must not absorb unrelated changes, generated output, or blind snapshot churn.

Every security-sensitive PR includes:

- a short risk note
- exact files changed
- focused tests run
- standard validations actually run
- remaining limitations
- migration and rollback behavior when persistence changes
