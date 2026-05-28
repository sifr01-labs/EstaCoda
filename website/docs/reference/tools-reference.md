---
title: Tools Reference
description: Tool classes, risk boundaries, availability rules, and failure modes.
sidebar_position: 6
---

# Tools Reference

EstaCoda extends its capabilities through tools. A tool is a typed function that the LLM can request during a turn. The system decides which tools are visible, whether they execute, and what happens when they fail. This page documents the implemented tool surface, not future or registered-only stubs.

---

## What is a tool

A tool has:
- A name (e.g., `file.read`, `web.search`)
- An input schema (OpenAI-compatible JSON Schema)
- A risk class (`safe`, `caution`, `read-only-network`, `external-side-effect`)
- A set of toolsets (e.g., `core`, `web`, `browser`)
- An availability predicate

The runtime registers tools in phases:
1. Pre-skill visibility (built-in, workspace, web, media, voice, vision, cron, memory, config)
2. Post-skill visibility (skill-selected tools)
3. Post-memory provider (knowledge tools)
4. Post-tool executor (delegation, execute_code)

MCP servers are discovered at runtime creation and registered alongside built-in tools.

---

## Tool classes

### Built-in tools

Static tools that are always registered if their provider is loaded.

| Tool | Risk | State touched |
|------|------|---------------|
| `workflow.plan` | `read-only-local` | None |
| `trajectory.record` | `read-only-local` | SQLite (trajectory events) |

### Workspace tools

File-system operations scoped to the workspace and operating under trust boundaries.

| Tool | Risk | State touched |
|------|------|---------------|
| `file.read` | `safe` | None |
| `file.write` | `caution` | Workspace files |
| `file.replace` | `caution` | Workspace files |
| `file.search` | `safe` | None |

**Trust boundary:** `file.write` and `file.replace` require workspace trust in strict security mode. In normal mode they may prompt for approval. In open mode they auto-approve unless a hard safety block triggers.

**Hardening:** Invalid regexes are caught before execution. Symlink-cycle-safe recursive search. Portable shell fallback for search.

### Web tools

Network read operations. They do not mutate remote state.

| Tool | Risk | State touched |
|------|------|---------------|
| `web.search` | `read-only-network` | None |
| `web.extract` | `read-only-network` | None |
| `web.crawl` | `read-only-network` | None |

**Availability:** Requires a configured web backend or provider. `web.search` depends on a web research provider registry.

**Failure modes:**
- Missing provider key returns a clear error with the expected env var.
- Rate limits surface as tool errors with retry guidance.
- Unsupported provider stubs return "not implemented" errors.

### Browser tools

Local browser automation via CDP or remote browser backend.

| Tool | Risk | State touched |
|------|------|---------------|
| `browser.*` | `external-side-effect` | Browser session state |

**Availability:** Requires a configured browser backend. Cloud browser providers are registered but not live-proven in v0.1.0.

**Failure modes:**
- No configured backend returns an unavailable status.
- CDP connection failures surface as execution errors.

### Media tools

Image generation and vision analysis.

| Tool | Risk | State touched |
|------|------|---------------|
| `image.generate` | `external-side-effect` | Writes image files |
| `vision.analyze` | `safe` | None |

**Availability:** `image.generate` requires a configured image generation provider and API key. `vision.analyze` requires a vision-capable model route.

### Voice tools

Text-to-speech and speech-to-text.

| Tool | Risk | State touched |
|------|------|---------------|
| `voice.speak` | `external-side-effect` | May play audio or write files |
| `voice.transcribe` | `safe` | None |

**Availability:** Hosted TTS requires a provider key. Local STT defaults to managed `faster-whisper` under `~/.estacoda/python-env`, or an explicit command engine. Voice readiness is exposed through CLI status surfaces, not through `isAvailable()` human-readable reasons.

**Implemented providers:**
- Hosted TTS: OpenAI, ElevenLabs, MiniMax, Gemini, xAI
- Hosted STT: OpenAI, Groq, xAI
- Local STT: managed faster-whisper by default, command with explicit `stt.local.engine: "command"`
- Deferred: local TTS providers, Mistral TTS/STT

### Code execution

| Tool | Risk | State touched |
|------|------|---------------|
| `execute_code` | `caution` | None (isolated execution) |
| `python` | `caution` | None (isolated execution) |

**Behavior:** Runs code in a subprocess with timeout escalation (SIGTERM then SIGKILL). Output is truncated before return. Does not write files unless the code itself does.

**Failure modes:**
- Timeout returns a truncated output with a timeout marker.
- Non-zero exit codes surface as tool errors with sanitized stderr.

### Cron tools

| Tool | Risk | State touched |
|------|------|---------------|
| `cronjob` | `caution` | Profile cron store, execution history |

**Actions:** `create`, `list`, `update`, `pause`, `resume`, `run`, `remove`.

**Behavior:** Cron jobs created through the tool use the same storage and validation as CLI cron commands. Prompt safety scanning applies. Recursion guard prevents cron jobs from scheduling more cron jobs.

### Memory tools

| Tool | Risk | State touched |
|------|------|---------------|
| `memory` | `safe` | Profile memory files |
| `memory.file_compact` | `safe` | Creates compaction backup |
| `memory.file_compaction_restore` | `safe` | Restores from backup |

**Behavior:** `memory.file_compact` compacts `USER.md` or `MEMORY.md`. It supports dry-run, scans generated output before writes, and creates backups. It never targets `SOUL.md` or `AGENTS.md`. Uses the auxiliary `memory_compaction` route.

### Skill tools

| Tool | Risk | State touched |
|------|------|---------------|
| `skill.*` | `safe` | None (read-only inspection) |

**Behavior:** Lists, inspects, and invokes skill workflows. Skill visibility depends on enabled packs and the current profile.

### Delegation tools

| Tool | Risk | State touched |
|------|------|---------------|
| `delegate_task` | `caution` | SQLite (delegation records) |

**Behavior:** Spawns a subagent in an isolated context. The parent receives only the final summary. Subagents cannot use `clarify`, `memory`, `send_message`, or `execute_code`.

### Config tools

| Tool | Risk | State touched |
|------|------|---------------|
| `config.compression.status` | `safe` | None |

**Behavior:** Shows normalized compression config, auxiliary route status, and latest session compression state. Does not mutate config or expose credentials.

### Knowledge tools

| Tool | Risk | State touched |
|------|------|---------------|
| `knowledge.*` | `safe` | SQLite (knowledge graph) |

**Availability:** Requires workspace root and post-memory provider initialization.

### Process tools

| Tool | Risk | State touched |
|------|------|---------------|
| `process` | `caution` | System processes |

**Behavior:** Lists, polls, logs, waits, kills, and sends input to background processes. Bounded by the host process permissions.

---

## Risk classes

| Class | Meaning | Approval behavior |
|-------|---------|-------------------|
| `safe` | Read-only, local, no side effects | No approval required |
| `caution` | May mutate local state or run code | Prompts in normal mode; auto-approves in open mode unless hard block |
| `read-only-network` | Reads from the network | Prompts in normal mode; auto-approves in open mode unless hard block |
| `external-side-effect` | Mutates external systems or costs money | Always prompts unless explicitly pre-approved |

Hard safety blocks override all modes. A hard block rejects the tool call regardless of YOLO mode or persistent approvals.

---

## Availability boundaries

A tool may be registered but unavailable. The runtime checks `isAvailable()` before offering a tool to the model.

### Provider readiness

Tools that depend on a provider route require the route to be configured and credential-ready.
- `web.search` requires a web research provider key.
- `image.generate` requires an image generation provider key.
- `voice.speak` requires a TTS provider key.
- `voice.transcribe` requires an STT provider, managed local faster-whisper, or an explicit local command.

### Workspace trust

Some tools require workspace trust:
- `file.write` and `file.replace` are gated by trust in strict mode.
- Workspace trust is per-profile and stored in `~/.estacoda/profiles/<id>/trust.json`.

### Security mode

The active security mode (`strict`, `normal`, `open`) changes which tools prompt, which auto-approve, and which are blocked entirely.

### Configured browser backend

Browser tools require a configured backend. Without one, they are registered but unavailable.

### MCP servers

MCP tools are discovered at runtime. If an MCP server is configured but unreachable, its tools are registered and marked unavailable. One-shot CLI commands see current MCP config automatically. Interactive sessions need `/reload-mcp` to refresh after config changes.

### Registered-but-not-implemented stubs

Some providers are catalog-known but not runnable:
- `anthropic`, `minimax`, `nous` are present in metadata but not executable in the current build.
- Unknown custom providers are treated as OpenAI-compatible but require explicit `baseUrl`.

---

## Common failures

### Unavailable tool

The tool is registered but `isAvailable()` returned false. Causes: missing provider key, missing workspace trust, unconfigured backend, unreachable MCP server.

**Recovery:** Check `estacoda doctor`, `estacoda settings provider`, or `estacoda mcp status`.

### Approval required

The tool call hit an approval gate. The user must respond with `once`, `session`, `always`, or `deny`.

**Recovery:** Grant approval, switch to a less restrictive security mode, or add a persistent approval for the matching action pattern.

### Denied by hard safety block

The tool call matched a hard safety rule and was rejected regardless of mode or approvals.

**Recovery:** Hard blocks are intentional. The action is unsafe. Reformulate the request or run the operation manually.

### Missing provider key

The tool requires an API key or token that is not present in the environment or `.env`.

**Recovery:** Set the expected env var or run `estacoda setup` / `estacoda model setup` for the provider.

### Unsupported provider stub

The provider ID is known in the catalog but has no live implementation.

**Recovery:** Use a live-proven provider. See the provider reference for maturity labels.

---

## Tool execution flow

1. Provider requests a tool call.
2. `ToolCallPlanner` converts the provider call to a `ToolCallPlan`.
3. `ToolExecutor` runs the tool under the active `SecurityPolicy`.
4. The result is packetized and returned to the provider.
5. Stored results are truncated to `maxResultSizeChars`.

---

## Related docs

- [CLI Commands](./cli-commands.md) — commands that inspect and configure tools
- [Slash Commands](./slash-commands.md) — in-session `/tools` and `/reload-mcp`
- [User Guide: Tools](../user-guide/tools.md) — tool concepts and workflows
- [Provider Reference](./provider-reference.md) — provider maturity and setup
