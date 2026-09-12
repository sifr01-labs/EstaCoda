# Desktop architecture foundation

Status: Desktop PRs 1–9 are implemented on the desktop branch. The Electron shell, profile-bound control-service bridge, live Work/Inbox controls, approved visual fixtures, Models/Providers, Telegram and managed worktree flows are available. The shared supervisor retains execution ownership.

Read this alongside the [Desktop delivery plan](../../planning/desktop-implementation-plan.md), [approved visual contract](../../planning/desktop-visual-contract.md), and [shared ownership decisions](../../planning/workspace-execution-ownership-decisions.md). Shared ownership decisions govern core authority; the visual contract governs presentation. Neither fixture data nor a UI projection grants execution authority.

## Product and delivery scope

Desktop is a local operator application for governed, persistent Work. Users can configure models and providers, create and inspect Work, resolve approvals, select Work-scoped model overrides, configure Telegram, and create/select managed worktrees. Files/diff/terminal and artifact workflows remain subsequent milestones. See the [Models and Providers guide](models-and-providers.md), [Work guide](work.md), [Connections and Telegram guide](connections-and-telegram.md), and [worktree guide](worktrees.md).

| Delivery | Scope |
| --- | --- |
| PR 1 | Product/ownership decisions, threat model, credential transaction, protocol/process decisions, and a minimal shared protocol workspace foundation |
| PRs 2–4 | Validated protocol, profile-bound bridge, canonical Work/Task/approval projections and controls |
| PR 5 | Secure Electron shell, existing-Work inspection proof, complete approved visual fixtures and regression gate |
| PR 6 | Live Models/Providers, reviewed setup/recovery, Session/Task model overrides |
| PR 7 | Live Work/Inbox controls, bounded attachments, canonical usage and restart recovery |
| PR 8 | Reviewed Telegram setup, gateway operations, canonical conversations and handoff |
| PR 9 | Core managed worktrees, reviewed creation/trust, fenced selection, archive and safe cleanup |
| PRs 10–12 and 16 | Files/diff/terminal, artifacts/evidence, view-only browser, packaged macOS alpha |
| PRs 13–15 | Browser takeover, governed Library/settings, scheduling |

General plugins, remote execution environments, organization/multi-tenant controls, automatic updates, and Desktop Docker management are outside the first alpha. Existing core Docker/copy support does not automatically expose a Desktop capability. Windows shared control remains gated on protected named-pipe support; macOS is the initial packaged target. The CLI stays independently installable and runnable.

## Canonical ownership

| Domain | Existing owner / code anchor | Desktop responsibility |
| --- | --- | --- |
| Profile selection and state paths | [profile-home](../../../src/config/profile-home.ts) | Select one profile per bridge; derive paths in trusted code; do not change the global active-profile pointer as a side effect of window selection |
| Workspace identity and target binding | [workspace-registry](../../../src/workspaces/workspace-registry.ts), [execution-target](../../../src/workspaces/execution-target.ts) | Project and request core mutations; never maintain a separate path-to-target registry |
| Session persistence / active execution | Session DB and [execution-ownership](../../../src/session/execution-ownership.ts) | Work is a projection; attaching is not acquiring execution ownership |
| Shared execution | [supervisor](../../../src/gateway/supervisor.ts), [shared-session-host](../../../src/gateway/shared-session-host.ts) | Bridge connects as a client; no second agent loop, Task scheduler, cron runner, or channel poller |
| Durable task outcomes | Existing Task/Step/Attempt stores, Task Results and artifact retention | Project Run/Results/Evidence; preserve failed, partial, cancelled and uncertain outcomes |
| Command authority | Existing security floor, trust and approval services | Display scoped requests and invoke their owner; UI state never bypasses hardline checks |
| Channel approvals and continuation | ChannelGateway, [control receipts](../../../src/gateway/control-receipts.ts) | Route operator controls to the supervisor; no direct queue resolution or adapter mutation |
| Models / credentials | [runtime credential resolver](../../../src/providers/runtime-credential-resolver.ts), [reviewed setup executor](../../../src/setup/review/apply-executor.ts) | Safe metadata, bounded candidate verification and reviewed profile-local apply |
| Usage | [provider usage ledger](../../../src/providers/provider-usage-ledger.ts) | Report known values and unavailable estimates honestly |
| Scheduling | Existing Cron store and execution records | Project schedules; closing a window does not cancel an enabled job |
| Bridge / windows / human PTYs | Electron Main; human PTYs remain planned | Own client and ephemeral human resources only; dispose on profile/window changes as specified |

Global trust, workspace approvals, Session DB, and shared memory remain global with their existing scoping rules. Config, `.env`, `auth.json`, ordinary memory, skills, gateway state and caches remain profile-local. Never infer authority from a session ID, target ID, process ID, alias, or cache hit.

## Work, lifetime, and presentation

Work/Run/Inbox/Evidence are read models over canonical records, not new lifecycle databases. Target working roots and source workspaces are distinct; a managed worktree is a working target, not a sandbox. Renderer-visible target generations and control operation IDs cannot stand in for trusted execution-owner fences.

Closing Desktop disposes its bridges and staged secrets; supervisor-owned work continues under existing authority. Switching profile clears visible content, handles, subscriptions and ephemeral human resources while leaving old-profile shared work running. Foreground CLI/ACP retain daemon-free execution and current session ownership checks. A foreign live owner cannot be stolen after a timeout. A disconnected bridge is not proof that execution stopped.

The approved UI has Work / Inbox / Library / Connections, top-sidebar Settings/Search/New chat, Pinned Work, workspace-grouped chats, and a runtime strip. Models and Appearance are within Settings. PR 5 uses the [frozen reference and assets](../../planning/desktop-design/README.md) and [acceptance matrix](../../planning/desktop-design/acceptance-matrix.md). Later live adapters reuse these components. Fixture entry points are isolated and absent from release entry points.

Appearance/layout/pin references are non-authoritative preferences. Draft content and attachment references must remain scoped to their profile/Work/target; they are not global browser-storage preferences. Production persistence/retention must use reviewed Main/core paths, with no renderer filesystem or database access.

Keyboard access, visible focus, named icon actions, Escape/focus restoration, reduced motion, zoom, readable contrast and mixed Arabic/English direction handling are required. Do not translate command names, provider identifiers or paths; isolate technical tokens. A visual specimen is not full accessibility certification.

## Review and remaining gates

The [threat model](threat-model.md) maps renderer, service, provider and channel attacks to required controls and their implementing PRs.

The [credential transaction design](credential-transactions.md) defines candidate lifetime, isolated transport, reviewed apply, cancellation races and the implemented recoverable profile Apply boundary.

The [protocol/process/packaging decisions](decisions.md) distinguish existing host wire v1 from the planned Desktop JSON-RPC transport and preserve CLI packaging through a pure shared-source facade.

[Desktop control protocol v1.0](control-protocol.md) documents the PR 2 executable schemas, negotiation, bounds and reconnect requirements. A declared contract does not imply an implemented service handler.

The [PR6 implementation record](../../planning/desktop-pr6.md) records core, browser/visual, native credential-window and packaged restart validation. Paid provider requests and real-account Codex authorization remain manual checks. Developer ID signing/notarization and distribution remain later gates.

Risk: downstream code could confuse a client bridge or a display projection with an authority owner. Review implementations against this matrix and the shared conformance cases. PR6 introduces reviewed profile persistence and Task model-event schema v36, with regression coverage for credential isolation, ownership and recovery.
