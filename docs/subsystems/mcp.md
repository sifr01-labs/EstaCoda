---
title: "MCP Integration"
description: "MCP client transport, discovery, and trust metadata."
---

# MCP Integration

## Files

| File | Role |
|------|------|
| `src/mcp/mcp-client.ts` | stdio and HTTP transport |
| `src/mcp/mcp-tools.ts` | Discovery, registration, trust mapping |

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

## Credentials

- `env` supplies literal, non-secret values to stdio servers.
- `envRefs` maps child-process variable names to variables loaded from the selected profile `.env`.
- Runtime resolution forwards only explicitly named variables through the sanitized child environment.
- Missing or invalid references fail closed before the MCP process starts, and errors include variable names only.

## Trust

- Server-level trust metadata maps MCP tools into EstaCoda risk classes.
- `toolRiskClasses` can override the risk of individual discovered operations by their unprefixed MCP tool name.
- Default trust is conservative: arbitrary third-party MCP tools start as `external-side-effect` unless configured otherwise.
- Unknown operations remain conservative even when known read operations have explicit overrides.
- Trusted workspaces can execute `read-only-local` MCP tools after explicit workspace trust.

Example generic capability configuration:

```json
{
  "mcpServers": {
    "records": {
      "toolRiskClasses": {
        "readRecords": "read-only-network",
        "updateRecords": "external-side-effect"
      },
      "protectedToolArguments": {
        "updateRecords": {
          "paths": ["/values/*/value"],
          "handling": {
            "persistence": "destination-managed",
            "sharing": "workspace"
          },
          "groupedDelivery": true,
          "browserRelay": true
        }
      },
      "toolVerificationRelationships": {
        "readRecords": ["updateRecords"]
      }
    }
  }
}
```

The CLI accepts the same map with `--tool-risk-classes TOOL=RISK,...`. When a per-tool map is present, unlisted operations use conservative server trust instead of inheriting the older broad `toolRiskClass` override. Without a map, `toolRiskClass` remains the legacy server-wide override.

`protectedToolArguments` contains reviewed JSON Pointer patterns only; it never contains credential values. `groupedDelivery` and `browserRelay` describe capabilities the generic secure dispatcher enforces. `toolVerificationRelationships` maps a read-only verification tool to the mutation tools whose resulting state it can independently verify. Tool names and protected paths are checked against the discovered MCP catalog and input schemas before any tools from that server are registered. Unknown tools, invalid or overlapping paths, non-string destinations, duplicate relationships, and risk conflicts leave the server unavailable with a bounded diagnostic.

The reviewed configuration tool accepts these structured fields directly. The CLI accepts `--protected-tool-arguments-json` and `--tool-verification-relationships-json`. `mcp status` reports only yes/no capability summaries; it never prints protected paths or credential values.

## Read Reuse

- Successful, complete read-only MCP results are reusable only within the current provider turn, selected profile, and Session.
- The key combines the tool name, normalized input hash, and current target revision. Raw inputs and raw results are not stored in the read ledger.
- Repeating an identical read returns a compact, redacted unchanged receipt instead of calling the MCP server again.
- Any allowed consequential MCP operation advances the target revision and invalidates prior MCP read receipts.
- Failed, partial, paginated, or truncated results are not authoritative cache entries.
- Large structured responses put a bounded, redacted outline before the full captured response so the model can usually work from request and collection metadata. A call with different explicit detail inputs remains a distinct read.
- Repeated-read, high-provider-call, and high-token-use notices are soft continuation guidance. They do not add a short user-facing timeout.

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
- Broader third-party server coverage needs operator validation.
