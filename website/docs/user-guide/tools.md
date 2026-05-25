---
title: Tools
description: Tool system, availability, execution, and failure modes for v0.1.0.
sidebar_position: 5
---

# Tools

Tools are bounded execution surfaces that extend what the agent can do. Every tool call routes through the runtime, passes security policy, and returns a structured result. There is no ungated tool execution.

This page explains how tools are organized, when they are available, and what happens when they fail.

---

## What Tools Are

A tool is a function the agent can invoke. Tools read files, write files, search the web, execute code, manage memory, schedule cron jobs, and perform other operations. Each tool has a risk class, a schema, and a runtime implementation.

Tools are not free capabilities. They are gated by configuration, provider readiness, workspace trust, and security mode.

---

## Tool Categories

### Built-In Tools

Built-in tools ship with EstaCoda and are always registered. Availability depends on configuration and provider state.

| Tool | Risk Class | Notes |
|---|---|---|
| `file.read` | `safe` | Reads files within the workspace |
| `file.write` | `caution` | Writes files; gated in adaptive/strict mode |
| `file.replace` | `caution` | Edits files; gated in adaptive/strict mode |
| `file.search` | `safe` | Searches files with regex |
| `web.search` | `read-only-network` | Web search via configured provider |
| `web.extract` | `read-only-network` | Extracts content from URLs |
| `web.crawl` | `read-only-network` | Crawls web pages |
| `browser.*` | `external-side-effect` | Requires browser backend config |
| `image.generate` | `external-side-effect` | Requires image provider credentials |
| `voice.speak` | `external-side-effect` | Requires TTS provider credentials |
| `voice.transcribe` | `safe` | Requires STT provider or local model |
| `execute_code` | `caution` | Executes code in a sandbox |
| `memory.*` | `safe` | Memory curation and compaction |
| `skill.*` | `safe` | Skill CRUD operations |
| `cronjob` | `caution` | Schedules and manages cron jobs |

### Provider-Backed Tools

Provider-backed tools are not standalone. They are requests the provider makes through the tool-calling protocol. The runtime resolves the tool name, validates the schema, and executes the implementation. If the provider does not support tool calling, tool execution is unavailable.

### MCP Tools

MCP (Model Context Protocol) tools are loaded from configured MCP servers. They are registered at runtime startup and refreshed with `/reload-mcp`. If an MCP server is missing or misconfigured, its tools are unavailable.

### Skill-Selected Tool Use

Skills can declare required toolsets. When a skill is visible in a session, its required toolsets are checked for availability. If a toolset is missing, the skill may still be visible but its instructions will note the limitation.

---

## Tool Execution Flow

1. Provider requests a tool call.
2. `ToolCallPlanner` converts the request to a `ToolCallPlan`.
3. `ToolExecutor` runs the tool under the active `SecurityPolicy`.
4. The result is packetized and returned to the provider.

Security policy runs before execution. The hardline floor blocks dangerous commands before the tool implementation runs. Adaptive mode may prompt for approval. Open mode allows non-hardline actions with minimal gating.

---

## Tool Availability

A tool is available only when:

- It is registered in the tool registry.
- Its required configuration is present (provider credentials, browser backend, etc.).
- The provider route is ready and runnable.
- Workspace trust does not block it.
- Security mode permits its risk class.

`/tools` inside an interactive session lists currently available tools. `/skills` lists visible skills and their required toolsets.

---

## Failure Modes

**Tool unavailable:** The tool is not registered or its configuration is missing. Check `/tools` for availability. Verify provider credentials, browser backend config, or MCP server status.

**Approval required:** The tool's risk class triggered an approval gate. Respond to the prompt or use `/approvals` to inspect pending grants.

**Denied by hard safety block:** The command matched a hardline pattern. The tool does not execute. Change the command; the block is unconditional.

**Missing provider key:** A provider-backed tool requires credentials that are not configured. Run `estacoda model setup` or set the required env var in the profile `.env`.

**Unsupported provider stub:** The provider advertises tool calling but the runtime does not yet implement the tool schema for that provider. Use a different provider or a built-in tool.

**Tool execution error:** The tool ran but encountered an error (file not found, network timeout, invalid regex). The error is returned to the provider as a structured result.

---

## Inspection

```bash
# List available tools in session
/tools

# List visible skills and toolsets
/skills

# Reload MCP servers
/reload-mcp

# Security audit
/security debug
```

---

## Related

- [Security and Approvals](./security-and-approvals.md) — risk classes and approval modes
- [Skills](./skills.md) — skill-required toolsets
- [CLI](./cli.md) — interactive tool listing and approval prompts
- [Channels](./channels.md) — channel tool availability
