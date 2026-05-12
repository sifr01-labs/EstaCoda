---
title: "MCP Integration"
description: "MCP client transport, discovery, and trust metadata."
---

# MCP Integration

## Files

| File | Lines | Role |
|------|-------|------|
| `src/mcp/mcp-client.ts` | ~420 | stdio and HTTP transport |
| `src/mcp/mcp-tools.ts` | ~517 | Discovery, registration, trust mapping |

## Transports

| Transport | Status | Evidence |
|-----------|--------|----------|
| stdio | Implemented | `live-proven` (filesystem server) |
| HTTP | Implemented | `smoke-tested` |

## Discovery

1. Config loads `mcpServers` / `mcp_servers`
2. Runtime creation calls `loadMcpServers(...)`
3. stdio: newline-delimited JSON-RPC
4. HTTP: JSON-RPC POST
5. Discovered tools registered into normal tool registry
6. Optional wrappers for `resource.list`, `resource.read`, `prompt.list`, `prompt.get`

## Trust

- Server-level trust metadata maps MCP tools into EstaCoda risk classes.
- Default trust is conservative: arbitrary third-party MCP tools start as `external-side-effect` unless configured otherwise.
- Trusted workspaces can execute `read-only-local` MCP tools after explicit workspace trust.

## Reload Semantics

- One-shot CLI commands see current MCP config automatically.
- Interactive CLI sessions need `/reload-mcp` to refresh.
- `estacoda mcp reload` confirms config-level reload.
- Channel turns rebuild from fresh config snapshots, so later turns see MCP changes without gateway restart.

## Commands

```bash
pnpm run dev -- mcp status
pnpm run dev -- mcp reload
```

## Limitations

- HTTP transport is not live-proven against real remote servers.
- Per-tool trust metadata is missing; only per-server trust exists.
- Broader third-party server coverage needs operator validation.
