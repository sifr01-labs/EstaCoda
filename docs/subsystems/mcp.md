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

`redactedToolResultPaths` is the corresponding reviewed output boundary for structured JSON results. Matching values are replaced before the result reaches the model, tool history, or persistence. If configured redaction cannot be applied to a returned structure, the entire result is withheld. The MCP server remains unavailable when a configured result-redaction tool is missing or its pointer declarations are invalid.

`artifactToolArguments` reviews a different boundary: exact string arguments that may receive a current-session governed browser download. The model supplies only the `artifact://` reference, download hash, and optional origin. Immediately before the already-approved MCP call, the runtime rechecks session ownership, source receipt, MIME type, size, file state, origin, and SHA-256, then injects UTF-8 text at the reviewed path. Artifact bytes do not enter model input or persisted tool arguments. Unknown tools, changed schemas, non-text files, changed files, and stale or cross-session references fail closed.

## Reviewed Postman protected-transfer recipe

Postman is configured through the same generic MCP entry as any other connector. It is not a Setup Editor integration and there is no Postman-specific runtime branch. This recipe is pinned to the inspected `@postman/postman-mcp-server` `2.11.2` minimal tool schemas; upgrades require schema discovery and test review before changing the pin.

```json
{
  "mcpServers": {
    "postman": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["--yes", "@postman/postman-mcp-server@2.11.2"],
      "envRefs": {
        "POSTMAN_API_KEY": "POSTMAN_API_KEY"
      },
      "trust": "conservative",
      "includeTools": [
        "getAuthenticatedUser",
        "getWorkspaces",
        "getCollections",
        "getCollection",
        "getEnvironments",
        "getEnvironment",
        "createCollection",
        "putCollection",
        "createEnvironment",
        "putEnvironment",
        "createSpec",
        "getSpec",
        "generateCollection",
        "getSpecCollections"
      ],
      "toolRiskClasses": {
        "getAuthenticatedUser": "read-only-network",
        "getWorkspaces": "read-only-network",
        "getCollections": "read-only-network",
        "getCollection": "read-only-network",
        "getEnvironments": "read-only-network",
        "getEnvironment": "read-only-network",
        "createCollection": "external-side-effect",
        "putCollection": "external-side-effect",
        "createEnvironment": "external-side-effect",
        "putEnvironment": "external-side-effect",
        "createSpec": "external-side-effect",
        "getSpec": "read-only-network",
        "generateCollection": "external-side-effect",
        "getSpecCollections": "read-only-network"
      },
      "artifactToolArguments": {
        "createSpec": {
          "paths": ["/files/*/content"],
          "allowedMimeTypes": ["application/json", "application/yaml"],
          "maxBytes": 12582912
        }
      },
      "protectedToolArguments": {
        "createEnvironment": {
          "paths": ["/environment/values/*/value"],
          "handling": {
            "persistence": "destination-managed",
            "sharing": "workspace"
          },
          "groupedDelivery": true,
          "browserRelay": true
        },
        "putEnvironment": {
          "paths": ["/environment/values/*/value"],
          "handling": {
            "persistence": "destination-managed",
            "sharing": "workspace"
          },
          "groupedDelivery": true,
          "browserRelay": true
        }
      },
      "redactedToolResultPaths": {
        "getEnvironment": ["/environment/values/*/value"]
      },
      "toolVerificationRelationships": {
        "getEnvironment": ["createEnvironment", "putEnvironment"],
        "getCollection": ["createCollection", "putCollection"],
        "getSpec": ["createSpec"],
        "getSpecCollections": ["generateCollection"]
      }
    }
  }
}
```

Store the Postman API key only in the selected profile's `.env`; the committed or reviewed config contains the environment-variable reference only. Use a dedicated Postman environment and create its related variables in one `createEnvironment` call. Each variable should use `type: "secret"`, and all two to eight protected values in that call are authorized as one group and dispatched once only after every source remains valid. A collection should contain references such as `{{service_client_id}}` and `{{service_client_secret}}`, never copied credential values.

When the source portal exposes OpenAPI or Swagger, capture it with `browser.download` and pass its receipt to `createSpec.files[*].content` through the artifact envelope. EstaCoda injects the validated text directly; do not paste the specification into a model-authored argument. Then use `generateCollection` and verify with `getSpec`, `getSpecCollections`, and `getCollection`. This is a generic artifact-to-MCP relay configured for Postman's inspected schema, not a Postman runtime branch.

Read back the environment with `getEnvironment` and the collection with `getCollection`. The output rule removes every environment variable value while preserving the environment name, variable keys, enabled state, and type for verification. `putEnvironment` replaces environment state; read the existing dedicated environment first and preserve all intended fields rather than using it as a partial patch.

After applying the recipe, reload MCP discovery and inspect `mcp status`. Protected delivery, grouped delivery, browser relay, artifact relay, result redaction, and verification should all report `yes`. A missing tool, changed input schema, invalid pointer, or non-JSON result that cannot be safely redacted fails closed without dispatching or returning the unreviewed data.

At execution time, the runtime copies only the validated connector and verification relationship into its bounded effect receipt. A successful verifier is associated with the most recent compatible successful mutation from the same visible turn, using target identity when both calls provide one. MCP results and model-authored plan text cannot create or override that relationship.

The reviewed configuration tool accepts these structured fields directly. The CLI accepts `--protected-tool-arguments-json`, `--artifact-tool-arguments-json`, `--redacted-tool-result-paths-json`, and `--tool-verification-relationships-json`. `mcp status` reports only yes/no capability summaries; it never prints reviewed paths, artifact contents, or credential values.

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
