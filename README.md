# EstaCoda

EstaCoda is a TypeScript agent runtime for local terminal work, channel-based operation, editor integration, workflow learning, and media-capable agent tooling.

The project is currently an **MVP candidate for private/internal use**. The core CLI agent, onboarding, provider setup, security modes, workflow-learning controls, multi-channel gateway, MCP client, ACP foundation, browser tools, voice/TTS foundation, cron with execution history, skills, memory, artifact paths, and **durable TaskFlow execution** are implemented and covered by smoke tests or live operator proof. It is not yet packaged as a public release.

Runtime contract: Node.js >= 22.18.0, pnpm via Corepack, and compiled `dist/` for production execution. Local source-mode development uses `pnpm run dev`; Bun is optional and informational only.

## Quick Start

```bash
cd /path/to/EstaCoda
corepack enable
pnpm install
pnpm run dev -- init
pnpm run dev -- setup
pnpm run dev
```

Build and run the production target:

```bash
pnpm run build
pnpm run start
# equivalent: node dist/index.js
```

Local installability checks use the compiled Node entrypoint, not a published package:

```bash
pnpm run verify:local-bin
scripts/verify-package-bin.sh
```

The package metadata now exposes an `estacoda` bin for packed installs, while public npm publication remains disabled with `private: true`. Do not use or document `npm install -g estacoda` or `npx estacoda` as supported until a release explicitly publishes the package. The hosted curl installer remains the intended launch direction.

`estacoda setup` is the canonical setup entrypoint. A bare `estacoda` launch checks setup state and may point you to setup when configuration is incomplete; the setup product flow itself lives under `estacoda setup`.

Interactive setup uses a reviewed setup flow:

- choose interface language and expression style
- trust the active workspace
- choose a primary model route
- store hosted-provider keys locally in the selected profile `.env` with `0600` permissions
- choose security mode: `strict`, `adaptive`, or `open`
- choose workflow-learning mode: `none`, `suggest`, `proactive`, or `autonomous`
- optionally configure Telegram, voice, vision/image generation, and browser support
- review the proposed setup before anything is applied
- apply approved setup writes, run structured verification, then choose launch handoff behavior

First-run setup silently creates and selects the default profile behind the scenes. Day-one setup remains the simple path: run `estacoda init`, run `estacoda setup`, then use EstaCoda. Profiles are available later for advanced multi-context use, but they are not required setup knowledge.

`estacoda setup --interactive` routes current setup state through the same reviewed setup system:

| Setup state | Interactive behavior |
|-------------|----------------------|
| First-run / no usable config | Runs first-run setup for language, workspace trust, primary provider/model, security, workflow learning, optional capabilities, review, apply, verification, and launch handoff. |
| Configured ready | Opens the guided setup editor so you can launch after verification, review setup, run read-only verification, or exit. |
| Configured degraded | Shows warnings and lets you repair setup, verify again, or continue only after explicitly accepting limited mode. |
| Partial provider or broken route | Uses provider/model repair through the shared provider/model flow before launch. |
| Missing credential | Repairs the credential reference for the active route; review shows env var references, not raw secrets. |
| Broken config | Shows config paths and parse/load diagnostics. Normal setup edits stay blocked until the config parses. |
| Untrusted workspace | Offers explicit workspace trust review before local file or terminal work. |
| State not writable | Shows state/config path guidance and blocks normal writes until permissions are restored. |

Verification is read-only. Review cancellation causes no setup mutation, including no config write, trust grant, or `.env` write. Launch never bypasses verification: it requires verified-ready setup, or a degraded state with warnings shown and limited mode explicitly accepted.

Advanced users can still use direct provider/model setup flags:

```bash
estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
estacoda setup --advanced --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
```

These direct flags are advanced compatibility paths. Guided setup and repair use the shared provider/model flow and reviewed apply path.

## Core Capabilities

- Provider-backed CLI agent loop with real tool execution.
- Capability-first security with approval modes, hard safety floor, `/yolo`, and audit/debug views.
- Profile-first configuration with local secret storage; the selected profile config defines the agent.
- Bounded memory through profile-local `USER.md`, `SOUL.md`, `MEMORY.md`, global shared memory, and workspace `AGENTS.md`.
- Skill system with visibility, usage telemetry, evolution overlays, gated proposals, snapshots, rollback, and scored eval fixtures.
- **Multi-channel gateway (v0.9):**
  - **Telegram** — live-proven: allowlists, approvals, sessions, attachments, voice transcription hooks, generated-image delivery, pairing codes.
  - **Discord** — implemented: DM/channel/thread support, allowlists, attachments, text delivery. Slash commands deferred to v0.9.1.
  - **Email** — implemented: IMAP receive, SMTP send, reply-in-thread, attachments, allowed senders, home address. Uses global security policy; no email-specific approval friction.
  - **WhatsApp** — experimental: Baileys linked-device adapter, QR/pairing-code login, DM-first, media, chunking. Gated behind `experimental: true`. See security docs for unofficial-API risk.
- **DeliveryRouter** — normalized delivery path for all channels: local, origin, Telegram, Discord, WhatsApp, Email, silent.
- MCP client for stdio and HTTP servers, including reload semantics.
- ACP stdio server foundation for editor clients.
- Browser automation through a local Chrome DevTools Protocol backend.
- **Cron jobs (v0.9 hardened)** — persistent store, prompt scanning, script-backed jobs, tick locking, per-job duplicate prevention, execution history in SQLite, failure classification, delivery routing, recursion guard.
- Voice/TTS/STT configuration foundation and audio artifacts.
- Image generation with FAL and BytePlus/ModelArk Seedream provider support.
- English and Arabic first-run onboarding, with localized setup labels, supported status copy, and LTR isolation for technical tokens in onboarding-owned surfaces.
- **Durable TaskFlow execution** (v0.8): multi-step flows with pause/resume/interrupt/cancel, step-level status, operator steer, approval gates, safe-boundary compaction, and restart recovery.
- **Operator surface (v0.9):** CLI commands for gateway status/diagnose/start/stop/restart, channels enable/disable/list/status, cron list/show/history/run/pause/resume/remove, sessions list/show/current/attach/detach.
- **Cross-surface sessions (v0.9):** explicit attach/detach via surface pointers; CLI↔Telegram handoff with short-lived single-use codes.
- **Gateway startup and restart:** `estacoda gateway start` runs the supervisor in the foreground; `estacoda gateway start --dry-run` performs local readiness checks without acquiring the gateway lock or writing PID/lock state; `estacoda gateway start --background` starts the gateway in the background and writes stdout/stderr to the selected profile `logs/gateway.log`. `estacoda gateway start --profile <id>` starts a gateway bound to that profile. `estacoda gateway stop` sends SIGTERM and waits up to 10s; `estacoda gateway stop --force` forces termination. `estacoda gateway restart` stops the old gateway, background-starts a new gateway, and returns; `estacoda gateway restart --graceful` is an alias for `restart` in v0.1.0.
- **Per-channel busy policy:** configure `busyPolicy` (`reject`, `queue`, `interrupt`) and `queueDepth` (clamped to `[1, 10]`, default `3`) independently per channel.

## UI / CLI Rendering (v0.95)

EstaCoda v0.95 introduced a structured rendering pipeline for all CLI and channel output:

- **ViewModel layer** — pure data types (`status`, `table`, `list`, `approval`, `timeline`, `progress`, `startup`, `assistantResponse`, etc.)
- **Renderer layer** — `PlainRenderer` (ASCII-only, no ANSI) and `StandardRenderer` (ANSI colors, Unicode symbols, animation)
- **Surface Adapter layer** — channel-safe formatters for Telegram, Discord, Email, WhatsApp, and plain logs
- **Terminal capability detection** — automatic fallback based on `isTTY`, `NO_COLOR`, `TERM=dumb`, `CI`, and terminal width
- **Theme system** — base themes (`light` | `dark`) + skin overlays (`kemetBlue`) + mode overlays (`plain` | `standard`)

See [UI Architecture](docs/ui-architecture.md), [Theme & Tokens](docs/theme-tokens.md), and [Rendering Guide](docs/rendering-guide.md) for details.

## TaskFlow (v0.8)

TaskFlow adds durable, observable multi-step execution:

- **Flows** represent high-level objectives; **steps** represent discrete actions.
- State is persisted to SQLite alongside session data.
- Operator controls: `/flow` slash commands and `estacoda flow` CLI commands.
- `/steer` injects explicit operator guidance into the next turn.
- Safe-boundary compaction preserves the full audit trail.
- Restart recovery marks interrupted flows/steps on startup.
- Requires SQLite session persistence; not available with in-memory sessions.

See [TaskFlow Architecture](docs/architecture/taskflow.md) and [Operator Controls](docs/operations/operator-controls.md) for details.

## Checks

Run these before pushing changes:

```bash
cd /path/to/EstaCoda
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
git diff --check
```

For a clean first-run onboarding check:

```bash
rm -rf /tmp/estacoda-e2e-home
mkdir -p /tmp/estacoda-e2e-home
HOME=/tmp/estacoda-e2e-home pnpm run dev -- setup
```

## State

By default, user-level state lives under `~/.estacoda/`:

Global state:

- `active-profile.json`
- `trust.json`
- `workspace-approvals.json`
- `sessions.sqlite`
- `memory/shared/`
- `packs/`

Profile state lives under `~/.estacoda/profiles/<id>/`:

- `config.json`
- `.env`
- `auth.json`
- `USER.md`
- `SOUL.md`
- `MEMORY.md`
- `promotions.json`
- `skills/`
- `cron/`
- `logs/`
- `gateway/`
- `channel-media/`
- `audio-cache/`
- `image-cache/`
- `temp/`

There is no user/project config merge. Workspace trust is directory action trust only; it does not control config loading.

## Docs

- [Documentation Index](docs/README.md)
- [Architecture](docs/architecture/)
- [Subsystems](docs/subsystems/)
- [Operations](docs/operations/)
- [Roadmap](ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Onboarding

EstaCoda starts with a guided first-run setup when no usable configuration is found:

```bash
pnpm run dev -- setup
```

A bare `pnpm run dev` launch uses setup-route decisions when setup is incomplete, but setup changes are handled by the setup command.

The setup flow walks through:

1. Interface language and expression style.
2. Workspace trust.
3. Primary provider and model.
4. Protected API key capture into the selected profile `.env`.
5. Security mode (`strict`, `adaptive`, or `open`).
6. Workflow learning mode (`none`, `suggest`, `proactive`, or `autonomous`).
7. Optional capabilities: Telegram, voice, vision, image generation, browser automation.
8. Review of proposed setup changes before apply.
9. Read-only readiness verification after approved apply.
10. Launch handoff when verification is ready, or an explicit degraded state is accepted.

Credentials are stored locally with restrictive permissions. Advanced/direct setup can point EstaCoda at existing environment variables instead of pasting keys during setup.

Optional capabilities are separate from the primary LLM provider/model route. Telegram/channel setup is a remote-control surface and must be restricted to allowed user or chat identities. Voice, vision/image generation, and browser support are optional/native capability surfaces; skipping them does not make core setup invalid. Browser setup records references only and does not launch a browser during setup planning.

Workspace trust is path-scoped. A trusted workspace allows normal local file and terminal work under the configured security policy. It does not enable project config loading or change which profile config is used.

Advanced profile commands are available for multi-context setups:

```bash
estacoda profile create work
estacoda profile list
estacoda profile use work
estacoda profile show
estacoda profile delete old-work
estacoda profile rename work client-work
```

Use `--profile <id>` or `-p <id>` to select a profile for one command without changing the active profile. Only `estacoda profile use <id>` changes `active-profile.json`.

`open` mode is not "security off"; the hard safety floor remains active.

Runtime mutating onboarding tools are not exposed. Fallback models are configured through the model fallback path and `model.fallbacks`, not through the removed legacy backup-provider POC field.
