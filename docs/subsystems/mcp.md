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

Configured server descriptors survive independently of callable tool registration. Runtime and status surfaces distinguish `configured`, `connected`, `schemas registered`, `available`, and `exposed this turn`. A disabled server, missing environment reference, startup failure, schema-validation failure, or connected server with no callable schemas therefore remains discoverable by name and reports its bounded failure stage instead of disappearing from routing. `available` means callable schemas survived registration and normal availability checks; `exposed this turn` means at least one of those registered tools entered the current bounded provider inventory.

Normal MCP requests retain the 10-second default timeout. Package-runner-backed stdio startup (`npx`, `pnpx`, `bunx`, `uvx`, or `pnpm dlx`) receives a separate 30-second default initialization window so cold module loading does not make an otherwise valid connector disappear. An explicit per-server `connectTimeoutMs` still overrides this default.

Naming a configured but unavailable connector does not expose tools. It lets routing and governed-transfer preflight diagnose the connector outage together with all missing reviewed artifact, protected-input, result-redaction, and verification configuration. Reload or repair remains explicit.

## Connection failures and recovery

Runtime creation and `/reload-mcp` persist a bounded, redacted `mcp-connection-status` event with each connector's failure stage and error. Stdio exit and timeout errors include bounded server diagnostics with configured environment values redacted. Runtime summaries report degraded status when enabled connectors are unavailable.

For `npx` connectors, an already-cached exact package version can be launched directly. Scoped package names and version pins are parsed separately and the cached package's name/version must match; ranges, tags, and URLs use the package runner rather than an arbitrary cached version. Subprocess HOME remains isolated and only explicitly configured credentials are forwarded.

In an interactive CLI session, `/reload-mcp status` shows the current snapshot without starting a process. `/reload-mcp` makes one explicit refresh attempt through the existing session-preserving runtime refresh path. It reports failures rather than treating a configuration reload as a successful connection. It never replays destination writes; after successful discovery, ask to continue so the saved checkpoint is revalidated against the fresh registry.

A connector-blocked checkpoint can answer follow-up questions in a tool-free recovery turn instead of repeating only a preflight refusal. The saved task remains blocked; diagnostic model output cannot execute tools, reconnect, change credentials, or mark the task complete. The first blocker and recovery replies offer the explicit reload action. Missing credentials/configuration still require secure profile setup, not secrets pasted into chat. There is no automatic retry loop or implicit authorization change. Recovery questions remain conversational even after reconnection; an explicit continuation resumes execution.

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

For grouped browser relay, every source is validated before authorization and revalidated before any source is read. If one or more sources are incompatible, the tool receives all bounded source IDs and rejection codes together, such as `source-empty`, `source-replaced`, or `tab-mismatch`. Browser text, source values, refs, URLs, and raw exceptions are excluded. No authorization, source read, or connector dispatch occurs after initial validation fails; any acquired source bindings are released, and later failures still clear temporary bytes before returning.

`redactedToolResultPaths` is the corresponding reviewed output boundary for structured JSON results. Matching values are replaced before the result reaches the model, tool history, or persistence. If configured redaction cannot be applied to a returned structure, the entire result is withheld. The MCP server remains unavailable when a configured result-redaction tool is missing or its pointer declarations are invalid.

`continuityToolResultPaths` declares the small set of non-secret scalar identifiers and names that may enter the runtime-owned foreground-turn working set after result redaction. A reviewed root-level generic field such as `/id` is qualified with the read tool's entity (`getSpec` becomes `specId`) so it remains meaningful after packing. Successful MCP calls may also retain their non-secret identifier-shaped target arguments, including schema-valid target fields such as `workspace`, `collection`, and `environment`, so an exact locator already accepted by the connector survives later prompt packing. Mutation targets are refreshed only after success. Failed calls, undeclared result fields, connector-supplied continuity metadata, free-form result text, credential-like fields or values, and session/profile/turn/tool-call identifiers are ignored. Facts are bounded and scoped to the current profile, session, and visible turn. Configure the equivalent CLI input with `--continuity-tool-result-paths-json`.

`artifactToolArguments` reviews a different boundary: exact string arguments that may receive a current-session governed browser download. The model supplies only the `artifact://` reference, download hash, and optional origin. Immediately before the already-approved MCP call, the runtime rechecks session ownership, source receipt, MIME type, size, file state, origin, and SHA-256, then injects UTF-8 text at the reviewed path. After raw download feedback is compacted, a cumulative prompt-safe receipt retains the reference, sanitized filename, hash, validated origin, MIME type, and size so the same valid artifact can be relayed without downloading it again. Arbitrary artifact metadata, local backing paths, and artifact bytes do not enter that receipt, model input, or persisted tool arguments. Unknown tools, changed schemas, non-text files, changed files, and stale or cross-session references fail closed.

## Reviewed Postman protected-transfer recipe

Postman is configured through the same generic MCP entry as any other connector. It is not a Setup Editor integration and there is no Postman-specific runtime branch. This recipe is pinned to the inspected `@postman/postman-mcp-server` `2.11.2` minimal tool schemas; upgrades require schema discovery and test review before changing the pin.

```json
{
  "mcpServers": {
    "postman": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["--yes", "@postman/postman-mcp-server@2.11.2", "--full"],
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
        "getAsyncSpecTaskStatus",
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
        "getAsyncSpecTaskStatus": "read-only-network",
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
      "continuityToolResultPaths": {
        "getWorkspaces": ["/workspaces/*/id", "/workspaces/*/name"],
        "getCollection": ["/collection/id", "/collection/name", "/collection/info/_postman_id", "/collection/info/name"],
        "getEnvironment": ["/environment/id", "/environment/name"],
        "getSpec": ["/id"],
        "createSpec": ["/id", "/name"],
        "generateCollection": ["/taskId"],
        "getSpecCollections": ["/collections/*/id", "/collections/*/name"]
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

When the source portal exposes OpenAPI or Swagger, capture it with `browser.download` and pass its receipt to `createSpec.files[*].content` through the artifact envelope. EstaCoda injects the validated text directly; do not paste the specification into a model-authored argument. Verify the specification with `getSpec`. `generateCollection` accepts an asynchronous job: retain its task ID and poll `getAsyncSpecTaskStatus` with `elementType: "specs"`, the original spec ID as `elementId`, and the returned `taskId`. Read the task's actual status before retrying generation; an empty collection list does not diagnose a queue failure. After completion, verify with `getSpecCollections` and `getCollection`. This is a generic artifact-to-MCP relay configured for Postman's inspected schema, not a Postman runtime branch.

The start and status tools form a complete task-relevant toolbox. Postman's `--full` flag is needed to advertise the async status tool; EstaCoda still exposes only the 15 tools in this recipe's `includeTools`, not the full upstream catalog. Existing profiles must apply the updated recipe (including launch arguments, `includeTools`, risk classes, and continuity paths) through MCP setup and reload their live session; documentation changes do not mutate local profiles. Do not automatically override explicit tool exclusions.

Read back the environment with `getEnvironment` and the collection with `getCollection`. The output rule removes every environment variable value while preserving the environment name, variable keys, enabled state, and type for verification. `putEnvironment` replaces environment state; read the existing dedicated environment first and preserve all intended fields rather than using it as a partial patch.

After applying the recipe, reload MCP discovery and inspect `mcp status`. It should report configured, enabled, connected, schemas registered, and available as `yes`; the in-session `config.mcp.status` tool also reports whether the connector was exposed in the current turn. Protected delivery, grouped delivery, browser relay, artifact relay, result redaction, and verification should all report `yes`. A missing tool, changed input schema, invalid pointer, or non-JSON result that cannot be safely redacted fails closed without dispatching or returning the unreviewed data.

At execution time, the runtime copies only the validated connector and verification relationship into its bounded effect receipt. A successful verifier is associated with the most recent compatible successful mutation from the same visible turn, using target identity when both calls provide one. When a durable operation has no connector-specific verification parser, that reviewed relationship may verify it only when exactly one compatible pending operation exists; failed or ambiguous reads do not. MCP results and model-authored plan text cannot create or override that relationship.

The reviewed configuration tool accepts these structured fields directly. The CLI accepts `--protected-tool-arguments-json`, `--artifact-tool-arguments-json`, `--redacted-tool-result-paths-json`, and `--tool-verification-relationships-json`. `mcp status` reports only yes/no capability summaries; it never prints reviewed paths, artifact contents, or credential values.

## Read Reuse

Reviewed verification calls require a non-secret identifier from `continuityToolResultPaths` in the redacted **result**, not just a successful response or an input identifier. Empty or inconclusive reads leave the mutation pending; they do not stop independent work or grant permission to repeat creation. Readback of an environment proves resource presence, not functioning authentication. Connectors without reviewed result identifiers remain callable, but do not produce automatic verification evidence.

Task/job status tools and pending structured results are read live, as are verification reads without positive evidence. They do not reuse unchanged-read receipts. This prevents an earlier pending/empty response from hiding externally completed work. Ordinary stable reads retain their existing reuse behavior.

The working set merges bounded historical checkpoint identifiers on every provider iteration, separately from its 24 live facts. Successful reviewed remote task/job IDs can enter the checkpoint as `task_id` facts. When the successful call targets an exact specification, collection, or resource ID already associated with one grounded source row on that connector, the returned task ID is retained in that row too. Failed, ungrounded, ambiguous, or cross-connector calls do not create that relationship. Historical locators survive live-fact invalidation and eviction but are not claims of current existence; terminal checkpoints are no longer projected.

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
