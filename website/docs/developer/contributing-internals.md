---
title: Contributing internals
description: Internal contribution patterns for providers, tools, channels, runtime wiring, tests, and safety boundaries.
sidebar_position: 7
---

# Contributing internals

This page is for contributors changing EstaCoda internals. It explains where code lives, which boundaries matter, and how to add runtime pieces without weakening the safety model.

General contribution workflow, pull request expectations, and full validation commands live in `CONTRIBUTING.md` and `AGENTS.md` at the repo root. This page focuses on code structure and implementation patterns.

---

## What this page covers

Use this page when you need to:

- add or modify a provider adapter
- add or modify a tool
- add or modify a channel adapter
- debug runtime construction or `AgentLoop` setup
- touch memory, gateway, security, prompt assembly, or provider routing
- write tests that mock runtime infrastructure
- decide whether a type belongs in `src/contracts/`

If a change affects commands, approvals, credentials, memory, remote channels, skill loading, workspace trust, or provider prompts, treat it as security-sensitive.

---

## Codebase layout

EstaCoda is organized by runtime domain. Common top-level directories include:

| Directory | Owns |
|---|---|
| `src/runtime/` | Runtime construction, agent loop wiring, provider turn loop integration, session builders |
| `src/providers/` | Provider adapters, provider metadata, model route resolution, provider execution helpers |
| `src/tools/` | Native tool definitions, tool providers, tool registration plan |
| `src/prompt/` | Prompt assembly, provider history preparation, compression, context packing |
| `src/memory/` | Local memory, curation, external memory integration, retrieval, indexing, compaction |
| `src/security/` | Workspace trust, approvals, command assessment, security policy construction |
| `src/channels/` | Channel adapters, channel gateway, delivery helpers |
| `src/gateway/` | Gateway supervisor, hooks, resilience, service lifecycle |
| `src/cron/` | Cron job tools and storage |
| `src/delegation/` | Subagent delegation, child runners, delegation diagnostics |
| `src/workflow/` | Durable workflow execution and workflow state |
| `src/evolution/` | Agent evolution review, proposals, constraints, export surfaces |
| `src/knowledge/` | Code graph and knowledge cache support |
| `src/lifecycle/` | Install, update, uninstall, and state preservation helpers |
| `src/packs/` | Pack install, registry, and risk classification |
| `src/setup/` | Onboarding, setup editor, setup verification, localized setup copy |
| `src/acp/` | ACP editor integration |
| `src/cli/` | CLI commands, interactive session loop, launch flow |
| `src/config/` | Runtime config loading, profile resolution, state-home paths |
| `src/contracts/` | Shared TypeScript contracts between subsystems |

Treat this as a map, not an exhaustive inventory. The filesystem is the source of truth.

---

## Import boundaries

Use shared contracts for cross-subsystem boundaries. Keep implementation modules behind narrow interfaces.

Rules of thumb:

- Leaf subsystems may import from `src/contracts/` and narrowly from `src/config/`.
- Leaf subsystems should avoid importing runtime composition code.
- `src/runtime/` is a composition area. It is allowed to wire subsystems together.
- CLI and gateway entry points may call runtime construction.
- Tests may import deeper surfaces when the behavior under test requires it.

`src/index.ts` is the CLI entry point. It parses early CLI state, handles setup and side-effect-free commands, loads config, opens the session DB, and creates the CLI runtime through `createRuntime()`.

When adding a dependency between subsystems, ask whether a contract type or small boundary function would keep ownership clearer.

---

## Contracts

Cross-subsystem contracts live in `src/contracts/`.

| File | Defines |
|---|---|
| `provider.ts` | Provider IDs, model profiles, provider requests/responses, streaming events, route metadata |
| `tool.ts` | Tool definitions, risk classes, tool providers, tool handlers |
| `channel.ts` | Channel messages, channel replies, adapter capabilities, channel adapters |
| `memory.ts` | Memory records, memory prompt context, external memory provider contracts |
| `security.ts` | Approval modes, environment type, security policy inputs |
| `session.ts` | Session records, messages, events, diagnostics |
| `runtime-event.ts` | Runtime events emitted while work is running |

Contracts should not import implementation modules. They may import other contracts when the type boundary genuinely crosses subsystems.

Do not change a contract just because a new implementation exists. Change a contract when the boundary itself changes.

Examples:

- A new provider normally implements the existing `ProviderAdapter` contract.
- A new channel normally implements the existing `ChannelAdapter` contract.
- A new external memory backend normally implements the existing external memory provider contract.
- A new cross-subsystem capability may require a contract change and tests for every affected implementation.

---

## Runtime composition

`createRuntime()` in `src/runtime/create-runtime.ts` is the main composition surface. It builds process-level runtime substrate such as config-derived registries, stores, memory infrastructure, browser lifecycle, cron support, skill loading, provider registry inputs, and security policy wiring.

Session-specific construction is handled by `AgentLoopBuilder` in `src/runtime/agent-loop-builder.ts`.

| Phase | Lifetime | Examples |
|---|---|---|
| Runtime substrate | Process/runtime lifetime | Stores, registries, profile-derived configuration, browser lifecycle, cron store, shared services |
| Session construction | Session lifetime | Tool registry, session-scoped tools, provider turn loop, agent loop, delegation manager |

If a component should survive across turns in a gateway session, it usually belongs in the runtime substrate. If it must be fresh for each session, it usually belongs in session construction.

Gateway sessions may use `RuntimeCache` from `src/runtime/runtime-cache.ts`. The cache is keyed by session context and invalidates when the runtime fingerprint changes.

---

## Adding a provider

Provider adapters implement `ProviderAdapter` from `src/contracts/provider.ts`.

Required adapter methods:

| Method | Purpose |
|---|---|
| `health(endpointOverride?)` | Check whether the adapter is available. |
| `listModels()` | Return runnable model profiles exposed by the adapter. |
| `complete(request, options)` | Run a non-streaming completion request. |

Optional adapter methods:

| Method | Purpose |
|---|---|
| `stream(request, options)` | Run a streaming completion request when the provider supports it. |

Typical steps:

1. Add the provider implementation under `src/providers/`.
2. Implement the existing provider contract.
3. Add or update provider metadata only when the route needs metadata beyond the adapter implementation.
4. Register the adapter where the provider registry is built.
5. Add tests for request shaping, credentials, model listing, error handling, and any fallback behavior.
6. Update [Provider runtime](./provider-runtime.md) only if runtime behavior or provider support boundaries changed.

Do not assume every provider supports tools, streaming, structured output, reasoning, images, or native tool history. Those capabilities must come from route metadata, model profile capability, and adapter behavior.

---

## Adding a tool

Tools are defined in `src/tools/` and exposed through tool providers.

A registered tool includes:

| Property | Purpose |
|---|---|
| `name` | Stable model-facing identifier |
| `description` | Model-facing description |
| `inputSchema` | JSON Schema for accepted input |
| `riskClass` | Approval and execution risk class |
| `toolsets` | Capability groups that expose or filter the tool |
| `progressLabel` | Short UI/status label while the tool runs |
| `maxResultSizeChars` | Bound for model-facing result text |
| `isAvailable()` | Runtime/session availability check |
| `run(input, context)` | Tool handler |

Current tool risk classes are:

```text
read-only-local
read-only-network
workspace-write
external-side-effect
credential-access
destructive-local
shared-state-mutation
spend-money
sandbox-escape
```

Tool registration is centralized through `toolRegistrationPlan` in `src/tools/index.ts`.

| Phase | Typical use |
|---|---|
| `pre-skill-visibility` | Core tools available before skill visibility is finalized |
| `post-skill-visibility` | Tools exposed by loaded skills |
| `post-memory-provider` | Tools that depend on memory provider setup |
| `post-tool-executor` | Tools that depend on executor infrastructure |

Typical steps:

1. Add or update a tool provider under `src/tools/`.
2. Use the narrowest accurate `riskClass`.
3. Validate paths, commands, URLs, credentials, and external targets before side effects.
4. Return structured failures rather than throwing for expected user/runtime failures.
5. Register the provider in the correct phase.
6. Add focused tests for success, failure, denial, and boundary behavior.
7. Update [Tool runtime](./tool-runtime.md) if execution semantics changed.

Never broaden command approvals, trust checks, or path handling to make a tool easier to call.

---

## Adding a channel adapter

Channel adapters implement `ChannelAdapter` from `src/contracts/channel.ts`.

Common fields and methods:

| Field or method | Purpose |
|---|---|
| `kind` | Channel identifier such as `telegram`, `discord`, or `email` |
| `delivery` | Optional outbound delivery and streaming capabilities |
| `start(handler)` | Start a long-running adapter and pass inbound messages to the gateway |
| `stop()` | Stop adapter resources cleanly |
| `receive(event)` | Convert a platform event into a channel event or message |
| `send(reply)` | Deliver a response |
| `getCapabilities()` | Return static capability metadata |
| `pollOnce()` | Poll for inbound messages |
| `pair()` | Run a pairing flow |
| `joinVoiceChannelForMessage()` | Join a voice channel for a message |
| `leaveVoiceChannelForMessage()` | Leave a voice channel for a message |

Typical steps:

1. Add the adapter under `src/channels/`.
2. Implement the `ChannelAdapter` contract.
3. Add config and launch support where the adapter is constructed.
4. Add or update channel auth policy handling if the channel accepts remote users.
5. Use gateway resilience for long-running adapters where appropriate.
6. Add tests for auth, message conversion, queue behavior, delivery, and stop/cleanup.
7. Update [Gateway internals](./gateway-internals.md) if supervisor or gateway behavior changed.

Adapters should not own approval routing. `ChannelGateway` owns auth, session scope, approval queue behavior, inline actions, and runtime invalidation.

---

## Testing patterns

Tests use Vitest and run on Node.js. Bun can be useful for local speed, but Node is the supported baseline.

Prefer behavior tests over broad snapshots. Use the helper patterns already present near the code under test.

| Target | Preferred pattern |
|---|---|
| Provider behavior | Mock `ProviderAdapter` or use local provider test helpers |
| Session storage | Use `InMemorySessionDB` or SQLite in a temporary directory |
| Filesystem behavior | Use temporary directories; avoid the real home directory |
| Runtime sessions | Prefer `AgentLoopBuilder` or targeted runtime tests over unrelated full-runtime setup |
| Channel behavior | Test auth, message conversion, queue handling, and cleanup without live credentials |
| Security behavior | Test both allowed and denied paths |

Focused commands:

```bash
pnpm exec vitest run src/providers/<file>.test.ts
pnpm exec vitest run src/tools/<file>.test.ts
pnpm exec vitest run src/channels/<file>.test.ts
```

Standard repo validation is listed in `AGENTS.md`. Do not claim a check passed unless it actually ran.

---

## Error handling

Use the lightest error shape that preserves control flow and diagnostics.

| Pattern | Use for |
|---|---|
| `Result<Ok, Err>` | Expected failures the caller must branch on |
| `throw` | Invariants, programmer errors, unexpected states |
| `AggregateError` | Multiple independent failures |
| `AbortController` | Cancellable provider calls, tools, turns, and long-running work |

Provider failures should include enough structured metadata for diagnostics without leaking secrets. Tool failures should be catchable by the agent loop and visible to the model when appropriate. Recoverable channel and gateway failures should be isolated, classified, and surfaced without silently corrupting session state.

---

## State and config boundaries

Runtime state belongs under the EstaCoda home directory, not inside arbitrary source paths.

| Boundary | Rule |
|---|---|
| Global state | Shared state under `~/.estacoda/`, such as active profile selection, trust, approvals, sessions, shared memory, packs, and profile resolution |
| Profile state | Profile-scoped state under `~/.estacoda/profiles/<id>/`, such as config, profile `.env`, memory files, skills, logs, gateway state, media/cache directories |
| Workspace state | Workspace trust is global directory-scoped state; do not treat project files as trusted config |
| Session DB | Session persistence is stored through the configured session DB path |
| Config | Runtime config loads one selected profile config per run; provider credentials resolve through configured env-var names and profile-local `.env` support |

If you add a new state file, decide whether it is global, profile-scoped, session-scoped, or temporary. Use the existing path resolvers in `src/config/` rather than hardcoding a home path.

---

## Security-sensitive changes

These areas need extra review:

| Surface | Why it is sensitive |
|---|---|
| Workspace trust | Controls whether EstaCoda may act in a directory |
| Tool approvals | Controls whether risky actions can run |
| Command execution | Can become local code execution |
| Path handling | Can become path traversal or unintended file access |
| Secrets and config | Can expose API keys, bot tokens, private paths, or credentials |
| Gateway and channels | Remote users can send messages and approvals |
| Memory | Durable context can affect future behavior |
| Skills and packs | Loaded instructions and tools can change runtime behavior |
| Prompt assembly | Untrusted content can affect provider behavior |

Use existing safe-path, redaction, approval, trust, and policy helpers from the subsystem you are touching. If a helper is missing, add a narrow one with tests instead of bypassing the boundary.

Do not bundle security-sensitive changes with unrelated refactors.

---

## Common tasks

### Add a model profile

1. Update the provider/model catalog path used by the provider.
2. Set capability metadata such as `contextWindowTokens`, `supportsTools`, `supportsVision`, `supportsStructuredOutput`, and `apiMode` where applicable.
3. Add or update tests for catalog loading, route resolution, aliases, provider diagnostics, and fallback behavior.

### Add a native intent

1. Change `src/contracts/intent.ts` only if the intent contract changes.
2. Add deterministic routing behavior in the relevant router or subsystem.
3. Add the handler in the agent loop or a pre-loop intercept where appropriate.
4. Test recognition, handling, false positives, false negatives, and ambiguous prompts.

### Add a diagnostic event

1. Add the event shape to the relevant contract if it is persisted or crosses subsystem boundaries.
2. Emit it from the owning subsystem.
3. Keep payloads coarse and secret-safe.
4. Add tests for the event and for fields that must be omitted.

### Add a gateway hook

1. Add the hook name and payload type in the gateway hook registry.
2. Emit it from the supervisor or resilience layer.
3. Keep payloads free of raw message text, tokens, secrets, and unnecessary identifiers.
4. Add tests for hook emission and cleanup.

---

## Source files to inspect

Start with these files when debugging internals:

| File | What it shows |
|---|---|
| `src/index.ts` | CLI entry point and CLI runtime creation |
| `src/runtime/create-runtime.ts` | Runtime substrate construction |
| `src/runtime/agent-loop-builder.ts` | Session construction and tool registration phases |
| `src/runtime/runtime-cache.ts` | Gateway runtime cache behavior |
| `src/contracts/provider.ts` | Provider request/response and adapter contracts |
| `src/contracts/tool.ts` | Tool definitions, providers, and risk classes |
| `src/contracts/channel.ts` | Channel messages, delivery, capabilities, and adapter contracts |
| `src/config/runtime-config.ts` | Runtime config loading and normalization |
| `src/security/security-policy-factory.ts` | Security policy construction |
| `src/prompt/prompt-assembly.ts` | Prompt construction order and provider history preparation |

---

## Related

- [Architecture](./architecture.md)
- [Runtime](./runtime.md)
- [Provider runtime](./provider-runtime.md)
- [Tool runtime](./tool-runtime.md)
- [Gateway internals](./gateway-internals.md)
- [Memory architecture](./memory-architecture.md)
