---
title: "Memory"
description: "Memory system: stores, promotion, rendering, and persistence."
---

# Memory

EstaCoda uses bounded, curated memory files that persist across sessions. The system distinguishes between global shared knowledge, profile user preferences, profile identity, profile learned facts, session recall, semantic session compression, and optional external recall.

Memory is durable execution context, so retrieved or generated memory is always subordinate to system, developer, repo, `AGENTS.md`, security, and current user instructions.

## Files

| File | Lines | Role |
|------|-------|------|
| `src/memory/memory-store.ts` | ~280 | Bounded memory file management |
| `src/memory/local-memory-provider.ts` | ~240 | Read/write memory entries |
| `src/memory/memory-renderer.ts` | ~180 | Render memory into prompt snapshots |
| `src/memory/memory-prompt-context-builder.ts` | ~200 | Canonical prompt memory context builder |
| `src/memory/memory-recall-orchestrator.ts` | ~230 | Per-turn recall and external-memory orchestration |
| `src/memory/memory-promotion.ts` | ~260 | Promote repeated preferences and facts |
| `src/memory/memory-tool.ts` | ~140 | Agent-facing `memory.curate` curation tool |
| `src/memory/memory-file-compaction-service.ts` | ~540 | Manual memory-file compaction and restore service |
| `src/memory/external-memory-provider.ts` | ~530 | External memory lifecycle helpers and file-backed provider |

## Memory Files

| File | Purpose | Char Limit | Location |
|------|---------|------------|----------|
| `memory/shared/` | Global shared memory snippets | Bounded by renderer | `~/.estacoda/memory/shared/` |
| `USER.md` | Profile user preferences and communication style | 1,375 (~500 tokens) | `~/.estacoda/profiles/<id>/USER.md` |
| `SOUL.md` | Profile agent identity and personality | Configurable | `~/.estacoda/profiles/<id>/SOUL.md` |
| `MEMORY.md` | Profile facts, conventions, and lessons | 2,200 (~800 tokens) | `~/.estacoda/profiles/<id>/MEMORY.md` |

`profiles/<id>/promotions.json` stores promotion metadata for that profile. There is no global `USER.md`, no global promotion store, and no `memory/default` path.

Render order:

```text
memory/shared/ -> USER.md -> SOUL.md -> MEMORY.md
```

`AGENTS.md` is not a memory file. It is project context loaded through `ProjectContextLoader`, and it should never be curated, compacted, deactivated, promoted, or mirrored as memory.

## Prompt Assembly

`MemoryPromptContextBuilder` is the canonical source for memory prompt context. It loads the local memory snapshot, applies promotion filtering, reports diagnostics, and emits prompt blocks for:

- shared memory and profile-local learned memory
- protected safety/identity memory from `SOUL.md`
- session recall blocks when supplied by the orchestrator
- external recall blocks when supplied by the orchestrator
- memory budget pressure diagnostics

Safety/identity memory is protected. Learned-memory deactivation can suppress promoted facts and preferences, but it cannot suppress `SOUL.md` or other protected safety context.

Prompt memory authority is deterministic:

```text
system/developer/repo/AGENTS/security/current user instructions > safety/identity and learned memory > reference-only recall/compression context
```

`AGENTS.md` remains project context, not memory. In the implemented prompt layer sequence, the ephemeral context renders the compaction notice, then session history, then session recall, then external recall, then the live user message. That render order is not an authority upgrade: recalled content, external recall, and compressed summaries are labeled untrusted/reference context and cannot override system, developer, repo, `AGENTS.md`, security, local memory, or current user instructions.

Duplicate `USER.md` / `MEMORY.md` injection is prevented by using one prepared `MemoryPromptContext` instead of independently rendering frozen and selective memory paths.

## Recall Orchestration

`MemoryRecallOrchestrator` prepares per-turn memory prompt context. Recall ownership follows this implemented path:

```text
AgentLoop -> MemoryRecallOrchestrator -> SessionRecallService
```

The orchestrator owns the decision flow for optional recall layers:

1. Build local memory context through `MemoryPromptContextBuilder`.
2. Detect explicit recall/continuity language.
3. Include bounded session recall only for high-confidence recall intents.
4. Include bounded external recall only when external memory is explicitly enabled and the same recall intent is present.
5. Attach diagnostic decisions explaining why recall was included or omitted.

Ordinary turns do not trigger broad recall. `ProviderTurnLoop` consumes the prepared memory context; it does not decide recall policy. `IntentRouter` does not currently emit recall-specific labels. Future router labels could become additive recall signals, but today the orchestrator's deterministic recall/continuity checks are the source of truth.

## Runtime Memory Refresh

Startup memory initializes the runtime `MemoryStore` from profile files and shared memory. For each user turn, `MemoryRecallOrchestrator` asks `MemoryPromptContextBuilder` to prepare the memory prompt context from that current in-memory store plus any eligible session or external recall.

When `memory.curate` changes memory during a session, the mutation updates the runtime memory store and persists to disk. Those changes can affect later turns in the same runtime, and the durable file changes remain available to future sessions.

## Promotion

`memory-promotion.ts` runs after the response path and uses **bounded session search** instead of scanning every session/message.

**Promoted content types:**

| Type | Destination | Evidence |
|------|-------------|----------|
| Repeated user preferences | `USER.md` | `smoke-tested` |
| Repeated project facts | `MEMORY.md` | `smoke-tested` |
| Skill outcomes | Memory store | `smoke-tested` |
| Manual conclusions | Memory store | `smoke-tested` |

**Features:**

- Contradiction handling for user preferences
- Strengthening (reinforcing existing entries)
- Forgetting (removing outdated entries)
- Inspection (listing current entries)

## Memory Tool

The agent-facing memory write surface is `memory.curate`. It accepts a `kind` value:

| Kind | Description |
|------|-------------|
| `append` | Append a new memory entry |
| `replace` | Replace an existing entry via substring matching (`match`) |
| `remove` | Remove an entry via substring matching (`match`) |

There is no `read` action — memory content is automatically injected into the system prompt.

`memory.curate` can write `USER.md`, `MEMORY.md`, and `SOUL.md`. It does not manage `AGENTS.md`. If external memory mirror writes are enabled, local writes remain authoritative and mirror failures are returned as warnings without failing the local write.

## Budget Pressure

Memory budget pressure is calculated for bounded memory files and reported as:

| Field | Meaning |
|-------|---------|
| `kind` | Memory file kind, such as `USER.md` or `MEMORY.md` |
| `source` | Source label; currently mirrors `kind` for memory-file pressure |
| `chars` | Current character count |
| `maxChars` | Configured character budget |
| `ratio` | `chars / maxChars` as a decimal |
| `percent` | Rounded percent of budget used |
| `state` | Pressure state |
| `remainingChars` | Remaining budget, floored at zero |
| `overflowChars` | Characters over budget, floored at zero |

| State | Meaning |
|-------|---------|
| `ok` | Under warning threshold |
| `warning` | At or above 80% of the file budget |
| `critical` | At or above 95% of the file budget |
| `overflow` | Over the file budget |

`MemoryStore.apply()` fails closed on overflow and returns structured overflow metadata to tool callers. Config numeric coercion for memory-adjacent features is NaN-safe; malformed values fall back to defaults or configured bounds instead of leaking `NaN` into runtime behavior.

## Memory File Compaction

Memory File Compaction compacts profile-local memory files, not session history. It is implemented by `MemoryFileCompactionService` and agent-facing tools:

| Tool | Purpose |
|------|---------|
| `memory.file_compact` | Manually compact `USER.md` or `MEMORY.md`; supports `dryRun` |
| `memory.file_compaction_restore` | Restore `USER.md` or `MEMORY.md` from a compaction backup |

Eligible files:

- `USER.md`
- `MEMORY.md`

Forbidden files:

- `SOUL.md`
- `AGENTS.md`
- shared memory files
- promotion metadata
- session history

The service uses the `memory_compaction` auxiliary route. It does not run automatically by default. Dry-run mode returns generated compacted text without writing or creating a backup. Applied compaction scans generated output with `MemoryScanner`, writes a timestamped backup under `.memory-file-compaction-backups/`, then writes the compacted file. Restore scans the backup before writing and creates a pre-restore backup of the current file.

Provider failures, missing `memory_compaction` routes, scanner blocks, invalid targets, and write failures fail closed and preserve the original file.

Memory File Compaction is separate from:

- TaskFlow compaction (`/flow compact <flowId>` / `estacoda flow compact <flowId>`)
- semantic session compression (`/compact` / `estacoda sessions compact ...`)
- deterministic history packing

## Session Recall

Manual recall is available through:

```bash
estacoda session recall <query>
estacoda sessions recall <query>
```

Interactive slash-command recall is available where the runtime exposes session recall:

```text
/session recall <query>
/sessions recall <query>
```

`SessionRecallService` uses SQLite FTS, groups hits by source session, loads bounded surrounding messages, and uses the auxiliary `session_search` route when configured. If auxiliary summarization is unavailable or fails, recall falls back to deterministic snippets.

Recall is profile-scoped and workspace-scoped when a workspace root is supplied. Sessions with matching workspace metadata are eligible; sessions with non-matching metadata are excluded. Metadata-less legacy sessions are excluded when workspace-scoped recall is active, but may be included in same-profile recall when no workspace root is supplied.

Every recall block is labeled as untrusted historical context and includes source session diagnostics. Recalled content cannot override system, developer, repo, `AGENTS.md`, security, local memory, or current user instructions.

Runtime recall is intentionally narrow. It is only injected for high-confidence continuity language such as "last time", "what did we decide", "what did I say about", "continue from", "we discussed", or relevant "remember ..." phrasing. Ordinary turns do not trigger broad recall.

## External Memory

External memory is optional and disabled by default. The implemented Phase 10 provider is file-backed and profile-local. It is configured under `externalMemory` and stores JSONL records beneath the selected profile's `external-memory/` directory.

External memory can:

- return bounded untrusted external recall for explicit recall turns
- mirror `memory.curate` writes when `mirrorWrites: true`
- expose provider status through internal provider status helpers

The external memory contract also defines `afterTurn` and `flushSession` hooks, and the file-backed provider implements safe handlers for them. These hooks are reserved for future orchestration unless a caller invokes them directly; current runtime orchestration does not actively call them. Implemented runtime paths are external recall and opt-in `memory.curate` mirror writes.

External memory cannot:

- replace `USER.md`, `MEMORY.md`, `SOUL.md`, shared memory, or session recall
- run unless explicitly enabled with a provider id
- use absolute storage paths
- write outside the profile `external-memory/` directory

File-backed external memory redacts record content, status diagnostics, provider warnings, and mirrored operation payloads. Failures are isolated as warnings.

## Workflow Learning Separation

Workflow learning is separated from memory files:

| Content Type | Destination |
|--------------|-------------|
| Facts/conventions | Profile-local `MEMORY.md` |
| User preferences | Profile-local `USER.md` |
| Persona/identity | Profile-local `SOUL.md` |
| Shared cross-profile knowledge | Global `~/.estacoda/memory/shared/` |
| Reusable procedures | Built-in skills plus profile-local `skills/` |
| Promotion metadata | Profile-local `promotions.json` |

## Session Compression Boundary

Semantic session compression is documented separately in [Semantic Session Compression](./semantic-compression.md). It rewrites older session history into reference-only summaries; it does not compact `USER.md`, `SOUL.md`, `MEMORY.md`, `AGENTS.md`, shared memory, or promotion metadata.

Memory File Compaction is also a separate path. It can compact `USER.md` and `MEMORY.md` only, uses the `memory_compaction` auxiliary route, and remains distinct from semantic session compression and TaskFlow compaction.

## Limitations

- External memory has only the file-backed provider in this implementation.
- There is no vector search or embedding store.
- External provider status helpers exist in code, but there is no standalone user-facing external memory status command documented as available.
- Memory File Compaction is manual/tool-driven by default.
