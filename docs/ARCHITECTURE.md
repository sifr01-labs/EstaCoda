# Architecture

This file is for engineering handoff and continuation work.

Evidence note:

- this file is primarily a structural map of the implemented codebase
- unless a section says otherwise, read architecture statements here as `implemented but not live-proven`
- use [HANDOFF.md](/Users/ahnwy/estacoda-v2/docs/HANDOFF.md) and [TESTING.md](/Users/ahnwy/estacoda-v2/docs/TESTING.md) for live-vs-smoke evidence

## System Map

### Entrypoints

- [src/index.ts](/Users/ahnwy/estacoda-v2/src/index.ts)
  Main boot flow. Also restores the active CLI workspace session from the persisted CLI session store before interactive launch. `implemented but not live-proven`
- [src/cli/cli.ts](/Users/ahnwy/estacoda-v2/src/cli/cli.ts)
  CLI command surface.
- [src/cli/session-loop.ts](/Users/ahnwy/estacoda-v2/src/cli/session-loop.ts)
  Interactive terminal loop. Handles in-session admin commands like `/sessions`, `/search`, `/switch`, and `/reset`. `smoke-tested`
- [src/cli/cli-session-store.ts](/Users/ahnwy/estacoda-v2/src/cli/cli-session-store.ts)
  Persisted active CLI session pointer keyed by workspace root. `smoke-tested`
- [src/channels/gateway-runner.ts](/Users/ahnwy/estacoda-v2/src/channels/gateway-runner.ts)
  Telegram gateway runtime wrapper.

### Core orchestration

- [src/runtime/create-runtime.ts](/Users/ahnwy/estacoda-v2/src/runtime/create-runtime.ts)
- [src/runtime/agent-loop.ts](/Users/ahnwy/estacoda-v2/src/runtime/agent-loop.ts)
- [src/runtime/intent-router.ts](/Users/ahnwy/estacoda-v2/src/runtime/intent-router.ts)

### Prompting

- [src/prompt/prompt-assembly.ts](/Users/ahnwy/estacoda-v2/src/prompt/prompt-assembly.ts)
- [src/prompt/history-packer.ts](/Users/ahnwy/estacoda-v2/src/prompt/history-packer.ts)
- [src/prompt/prompt-cache.ts](/Users/ahnwy/estacoda-v2/src/prompt/prompt-cache.ts)

### Providers

- [src/providers/provider-executor.ts](/Users/ahnwy/estacoda-v2/src/providers/provider-executor.ts)
- [src/providers/openai-compatible-provider.ts](/Users/ahnwy/estacoda-v2/src/providers/openai-compatible-provider.ts)
- [src/providers/provider-router.ts](/Users/ahnwy/estacoda-v2/src/providers/provider-router.ts)
- [src/providers/auxiliary-provider-router.ts](/Users/ahnwy/estacoda-v2/src/providers/auxiliary-provider-router.ts)
- [src/providers/credential-pool.ts](/Users/ahnwy/estacoda-v2/src/providers/credential-pool.ts)
- [src/providers/model-catalog.ts](/Users/ahnwy/estacoda-v2/src/providers/model-catalog.ts)

### Tools

- [src/tools/tool-registry.ts](/Users/ahnwy/estacoda-v2/src/tools/tool-registry.ts)
- [src/tools/tool-executor.ts](/Users/ahnwy/estacoda-v2/src/tools/tool-executor.ts)
- [src/tools/tool-call-planner.ts](/Users/ahnwy/estacoda-v2/src/tools/tool-call-planner.ts)
- [src/tools/tool-schema.ts](/Users/ahnwy/estacoda-v2/src/tools/tool-schema.ts)
- [src/tools/workspace-tools.ts](/Users/ahnwy/estacoda-v2/src/tools/workspace-tools.ts)
- [src/tools/media-tools.ts](/Users/ahnwy/estacoda-v2/src/tools/media-tools.ts)
- [src/tools/vision-tools.ts](/Users/ahnwy/estacoda-v2/src/tools/vision-tools.ts)
- [src/tools/web-tools.ts](/Users/ahnwy/estacoda-v2/src/tools/web-tools.ts)
- [src/tools/execute-code-tool.ts](/Users/ahnwy/estacoda-v2/src/tools/execute-code-tool.ts)

### MCP

- [src/mcp/mcp-client.ts](/Users/ahnwy/estacoda-v2/src/mcp/mcp-client.ts)
  MCP client transport for stdio and HTTP. stdio path `live-proven`; HTTP path `smoke-tested`
- [src/mcp/mcp-tools.ts](/Users/ahnwy/estacoda-v2/src/mcp/mcp-tools.ts)
  Discovery/registration layer plus server-level trust-to-risk mapping. `smoke-tested`

### ACP

- [src/acp/server.ts](/Users/ahnwy/estacoda-v2/src/acp/server.ts)
  ACP stdio JSON-RPC server, in-process ACP session manager, cwd-bound runtime creation, `session/update` streaming, editor-backed file reads via ACP fs requests, and approval bridging for gated shell actions. Basic JetBrains chat + file-read + approval flow is `live-proven`.

### Browser

- [src/browser/browser-backend.ts](/Users/ahnwy/estacoda-v2/src/browser/browser-backend.ts)
  Browser backend abstraction with mock and local Chrome CDP backends. Local CDP supports navigation, snapshots with `@eN` element refs, click/type/scroll/press/back actions, image listing, page-local console capture, raw CDP passthrough, and screenshots. Cloud backends are recognized in config but remain follow-up implementation work.
- [src/tools/web-tools.ts](/Users/ahnwy/estacoda-v2/src/tools/web-tools.ts)
  Web extraction plus Hermes-shaped browser tools: `browser.status`, `browser.navigate`, `browser.snapshot`, `browser.click`, `browser.type`, `browser.scroll`, `browser.press`, `browser.back`, `browser.get_images`, `browser.console`, `browser.cdp`, and `browser.screenshot`. Provider tool schemas are built from available tools only so unconfigured browser backends do not displace core/skill tools.

### Cron

- [src/cron/cron-store.ts](/Users/ahnwy/estacoda-v2/src/cron/cron-store.ts)
  Persistent scheduled-task storage at `~/.estacoda/cron/jobs.json`, atomic writes, schedule parsing for relative delays, intervals, cron expressions, and ISO timestamps, prompt safety scanning, optional workspace-local script metadata, plus local output files.
- [src/cron/cron-tools.ts](/Users/ahnwy/estacoda-v2/src/cron/cron-tools.ts)
  Hermes-shaped model-facing `cronjob` tool with create/list/update/pause/resume/run/remove actions, skill-list edits, and script fields.
- [src/cron/cron-runner.ts](/Users/ahnwy/estacoda-v2/src/cron/cron-runner.ts)
  Scheduler tick runner that executes due jobs, enforces `.tick.lock`, runs bounded workspace-contained scripts without shell expansion, handles `[SILENT]`, delivers origin/Telegram outputs when configured, and writes wrapped output to `~/.estacoda/cron/output/`.

### Skills

- [src/skills/skill-loader.ts](/Users/ahnwy/estacoda-v2/src/skills/skill-loader.ts)
- [src/skills/skill-registry.ts](/Users/ahnwy/estacoda-v2/src/skills/skill-registry.ts)
- [src/skills/skill-visibility.ts](/Users/ahnwy/estacoda-v2/src/skills/skill-visibility.ts)
- [src/skills/skill-tools.ts](/Users/ahnwy/estacoda-v2/src/skills/skill-tools.ts)
- [src/skills/skill-workflow-planner.ts](/Users/ahnwy/estacoda-v2/src/skills/skill-workflow-planner.ts)

### Channels

- [src/channels/channel-gateway.ts](/Users/ahnwy/estacoda-v2/src/channels/channel-gateway.ts)
- [src/channels/channel-session-store.ts](/Users/ahnwy/estacoda-v2/src/channels/channel-session-store.ts)
- [src/channels/telegram-adapter.ts](/Users/ahnwy/estacoda-v2/src/channels/telegram-adapter.ts)
- [src/channels/channel-approval-store.ts](/Users/ahnwy/estacoda-v2/src/channels/channel-approval-store.ts)
- [src/channels/telegram-format.ts](/Users/ahnwy/estacoda-v2/src/channels/telegram-format.ts)
- [src/channels/activity-labels.ts](/Users/ahnwy/estacoda-v2/src/channels/activity-labels.ts)

### Memory / session / trajectory

- [src/memory/memory-store.ts](/Users/ahnwy/estacoda-v2/src/memory/memory-store.ts)
- [src/memory/local-memory-provider.ts](/Users/ahnwy/estacoda-v2/src/memory/local-memory-provider.ts)
- [src/session/sqlite-session-db.ts](/Users/ahnwy/estacoda-v2/src/session/sqlite-session-db.ts)
- [src/session/in-memory-session-db.ts](/Users/ahnwy/estacoda-v2/src/session/in-memory-session-db.ts)
- [src/trajectory/trajectory-recorder.ts](/Users/ahnwy/estacoda-v2/src/trajectory/trajectory-recorder.ts)

## Runtime Composition

`createRuntime()` is the composition root.

It builds:

1. state stores
2. provider registry and auxiliary routes
3. tool registry
4. skill registries
5. prompt dependencies
6. `AgentLoop`

Important composition details:

- Official skills are loaded first.
- Personal/project/external skills are loaded next.
- Visible skill catalog is filtered per session using runtime conditions.
- `vision.analyze` is registered as a real tool and uses the auxiliary `vision` provider route preferences.
- Channel media directory is treated as an additional allowed root for relevant tools.
- Configured MCP servers are loaded during runtime creation and stopped during runtime disposal.

Key runtime products created here:

- provider registry
- auxiliary provider router
- tool registry
- visible skill registry
- prompt cache
- memory store
- artifact store
- session DB
- process manager
- provider executor
- tool executor
- agent loop

## Agent Loop Shape

`AgentLoop.handle()` is roughly:

1. receive text + attachments + channel
2. expand `@file:` / `@folder:` references
3. record input to session DB + trajectory
4. normalize attachment statuses
5. short-circuit on attachment preflight failures
6. route intent and skill
7. make security decision
8. assemble prompt
9. call provider
10. convert provider tool calls into plans
11. execute tools
12. build continuation prompt if needed
13. persist results, outcomes, artifacts
14. return text/progress/artifacts

Important guardrails inside the loop:

- attachment preflight can stop the turn before provider execution
- provider iterations are budgeted
- repeated tool failures are capped
- safe tool concurrency is bounded
- security decisions are attached to tool executions, not just final replies

## Provider Architecture

There are two layers:

1. **Registry / routing**
   - model catalog
   - provider registry
   - route selection by capability and preference

2. **Execution**
   - `ProviderExecutor`
   - streaming token collection
   - tool-call fragment assembly
   - fallback handling
   - credential-pool integration

Auxiliary routes exist for:

- `vision`
- `compression`
- `web_extract`
- `session_search`
- `skills_hub`
- `mcp`
- `memory_flush`
- `delegation`

These are preferences/routing constructs, not separate runtimes.

Important current distinction:

- chat-capable providers can be live inference routes
- some catalog providers are discovery-only and must not be treated as full runtime adapters
- vision routing is implemented in code, but live success depends on actual provider capability plus working credentials

## Prompt Architecture

Prompt assembly is layered and partly cacheable.

Key layers:

- identity / SOUL
- frozen memory snapshot
- compact skills index
- session history
- user message
- channel attachments
- intent
- skill instructions
- skill setup
- skill resources
- workflow plan
- tool menu
- project context
- explicit reference context
- tool results / continuation feedback

Important semantic rules:

- Session-stable system context is preferred over mid-session mutation.
- Skills are progressively disclosed.
- Attachments are structured context, not fake user text.
- Channel-facing formatting is handled after model generation, not by mutating the core runtime into a Telegram-specific reply engine.

## Skill Model

Skill sources:

- official
- personal
- project
- external

Visibility model:

- visibility is session-stable
- filtered by runtime conditions
- refreshed on `/reset` or new session

Skill operations:

- list
- view
- inspect
- create
- patch
- edit
- delete
- write_file
- remove_file
- import
- export

Execution model:

- provider-backed by default
- deterministic fallback path exists for no-provider sessions
- resources (`references/`, `templates/`, `scripts/`, compatible `assets/`) are indexed and loaded on demand

## Channel Architecture

`ChannelGateway` is the generic adapter bridge.

Responsibilities:

- auth / allowlist / pairing
- session mapping
- normalized session-key policy
- session auto-reset policy
- session-admin commands
- runtime construction
- progress delivery
- approval prompt delivery
- command handling
- fresh runtime creation from the latest config snapshot on the gateway path

## MCP Architecture

Current implementation:

1. config loads `mcpServers` / `mcp_servers`
2. runtime creation calls `loadMcpServers(...)`
3. stdio MCP servers are initialized over newline-delimited JSON-RPC, and HTTP servers are called over JSON-RPC POST
4. discovered tools are registered into the normal tool registry
5. optional wrappers are added for:
   - `resource.list`
   - `resource.read`
   - `prompt.list`
   - `prompt.get`
6. runtime disposal stops MCP subprocesses
7. server-level trust metadata maps MCP tools into EstaCoda risk classes
8. `npx`-configured stdio servers are resolved to cached installed binaries before launch so MCP stdio handshakes do not depend on the `npx` wrapper behaving like a transparent transport

Current operator semantics:

- one-shot CLI commands see current MCP config automatically
- interactive CLI sessions need `/reload-mcp` to refresh their live MCP snapshot
- `estacoda mcp reload` confirms config-level reload
- trusted workspaces can execute `read-only-local` MCP tools after explicit workspace trust is granted
- channel turns rebuild from fresh config snapshots, so later turns can see MCP config changes without a full gateway restart
- approval persistence/revocation

Telegram-specific concerns live in `TelegramAdapter`:

- polling
- attachment download
- callback query handling
- progress message editing
- final reply formatting

Important Telegram UX choices:

- one evolving progress message per active turn
- inline approval buttons map back into the same `/approve` and `/deny` command path
- final replies are formatted in a Telegram-safe HTML layer
- activity labels are localized through a shared label map, currently `en` and `ar`
- group sessions are per-user by default; thread sessions are shared by default unless configured otherwise
- active chat -> session mapping persists across gateway restarts
- channel session-admin surface now includes `/sessions`, `/search <query>`, and `/switch <session-id>` for the current normalized chat context. `smoke-tested`

## CLI Session Architecture

Interactive CLI session behavior is now split into two layers:

1. **runtime session**
   - the actual `sessionId` used by `createRuntime()` and the session DB
2. **workspace session pointer**
   - a persisted mapping from workspace root to the active CLI session id

The CLI startup path in [src/index.ts](/Users/ahnwy/estacoda-v2/src/index.ts) now:

1. loads the persisted workspace session id from [src/cli/cli-session-store.ts](/Users/ahnwy/estacoda-v2/src/cli/cli-session-store.ts)
2. builds the runtime with that session when present
3. persists the resulting active session id back to the same store

The interactive loop in [src/cli/session-loop.ts](/Users/ahnwy/estacoda-v2/src/cli/session-loop.ts) then updates that pointer when:

- `/reset` or `/new` creates a fresh session
- `/switch <session-id>` adopts an existing session

This means fresh CLI launches are no longer forced back onto the default `scaffold` session when a persisted workspace session already exists. CLI resume persistence is `smoke-tested`.

## Security Model

The security boundary is capability-first.

Important traits:

- approval modes are `strict`, `adaptive`, and `open`
- `adaptive` is the default and now uses deterministic triage first, then an optional auxiliary security assessor for ambiguous cases
- `open` still preserves a hard dangerous-command floor
- `/yolo` is a session-scoped CLI and gateway toggle for `open` mode, aligned with Hermes operator ergonomics, but it cannot bypass the hard floor
- assessor failures, malformed output, or timeouts fall back to `ask`
- tool risk classes drive gating
- structured `targetKey` values are the approval boundary
- display summaries are not the authorization boundary
- workspace trust allows normal local work to proceed proactively
- obvious risk classes still trigger approval logic
- persistent approvals match on normalized `targetKey` values, including operation type and normalized targets where supported
- channel approvals use `once`, `session`, and `always`
- CLI approvals now use the same `once`, `session`, and `always` scope model through runtime-backed grants and a workspace approval store
- the unconditional hard floor now covers broad/root-like recursive deletes, destructive disk operations, shutdown/reboot commands, fork-bomb or kill-all patterns, explicit secret reads, pipe-to-interpreter installs, and git force-pushes
- adaptive assessment now defaults to an auxiliary `approval` route when an assessor is enabled without an explicit provider/model override
- interactive CLI sessions expose `/security` and `/security debug` so operators can inspect recent decisions, target keys, deterministic rule hits, and assessor status without digging through raw session events

## Persistence Model

### Session persistence

- interactive/session state is written to session DB
- SQLite is used for the gateway path
- in-memory session DB is used in smoke/runtime scaffolding
- CLI session context is persisted separately from the session DB in `.estacoda/cli-sessions.json`
- channel session context is persisted separately from the session DB in `.estacoda/channel-sessions.json`
- channel session identity now includes explicit chat/thread policy rather than relying on accidental raw keying
- CLI and channel session pointers are separate stores because they solve different routing problems:
  - CLI maps workspace root -> active session
  - channels map normalized conversation identity -> active session

### Memory persistence

- `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`
- bounded budgets enforced by `MemoryStore`
- `LocalMemoryProvider` currently persists:
  - manual conclusions
  - promoted user preferences
  - promoted project facts/conventions
  - skill outcomes
- contradiction/forget/inspection for promoted user preferences now exists through the local promotion store
- bounded workflow learning is now separated from memory files:
  - facts/conventions -> `MEMORY.md`
  - user preferences -> `USER.md`
  - reusable procedures -> project skills under `<workspace>/.estacoda/skills/`
  - workflow learning state -> `<workspace>/.estacoda/skill-learning.json`
- `skills.autonomy` controls workflow-learning behavior:
  - `none`
  - `suggest`
  - `proactive`
  - `autonomous`

### Trajectory persistence

- `TrajectoryRecorder` records runtime events for future research/eval use

## Data Flow Summary

The most important end-to-end path today is:

1. input arrives from CLI or Telegram
2. runtime normalizes message + attachments
3. prompt assembly builds a layered provider request
4. provider responds with text and/or tool calls
5. tool planner + executor run concrete actions under policy
6. continuation prompt feeds tool results back to the provider if needed
7. final output is formatted per surface
8. session, memory, approvals, and trajectory state are persisted

## Testing Architecture

- `src/smoke.ts` is broad and important
- it acts as the main regression net for architecture and behavior
- `docs/INTERNAL_ALPHA_RUNBOOK.md` is the manual live-ops complement

## Current Architectural Weak Spots

- memory promotion now exists for repeated user preferences and project facts, but the broader learning system still needs better workflow heuristics and skill patch/update behavior
- provider message content types were only recently widened enough to support vision
- Telegram is the only real launch channel today
- gateway liveness is readiness-focused, not daemon/service-tracking
- some UX polish remains outside the core architecture
