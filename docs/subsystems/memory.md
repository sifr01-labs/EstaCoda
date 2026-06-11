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
| `src/memory/memory-persistence-service.ts` | ~300 | Drift-aware local memory write safety |
| `src/memory/memory-tool.ts` | ~140 | Agent-facing `memory.curate` curation tool |
| `src/memory/memory-index-store.ts` | ~260 | Profile-state SQLite schema/lifecycle for the local lexical index |
| `src/memory/memory-index.ts` | ~560 | Local lexical index writes, read/search, status, and vacuum |
| `src/memory/memory-index-sync.ts` | ~520 | Startup backfill and post-write index sync orchestration |
| `src/memory/memory-retrieval-service.ts` | ~620 | Bounded local lexical memory read/search with fallback |
| `src/cli/memory-commands.ts` | ~430 | CLI memory index/read/search commands |
| `src/tools/memory-retrieval-tools.ts` | ~270 | Agent-facing `memory.read` and `memory.search` tools |
| `src/memory/memory-file-compaction-service.ts` | ~540 | Manual memory-file compaction and restore service |
| `src/memory/external-memory-provider.ts` | ~530 | External memory lifecycle helpers and file-backed provider |
| `src/session/session-search-service.ts` | ~360 | Deterministic raw session browse/search/scroll |

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

## Retrieval Write And Storage Boundaries

Local memory retrieval keeps storage authority explicit. The local memory index lives in profile state as a dedicated SQLite file:

```text
<profile-state-dir>/memory-index.sqlite
```

The index is a rebuildable mirror of memory content, not source of truth. It is inspectable, safe to delete and rebuild, separate from authoritative memory files, and must not mix memory-index authority with session transcript authority. It follows the existing SQLite adapter, migration, and lifecycle patterns.

`memory-index.sqlite` lifecycle rules:

- Stored under profile state, for example `<profile-state-dir>/memory-index.sqlite`.
- Opened through the runtime/profile lifecycle.
- Closed and disposed with runtime disposal.
- Safe to delete while the runtime is stopped.
- Missing file at startup reports a pending rebuild.
- Bounded backfill may recreate the file.
- Full rebuild is explicit through `estacoda memory index rebuild`.
- Runtime cache/fingerprint accounts for retrieval config and index path.

Authoritative memory source invariants:

- `MemoryStore` remains the in-memory representation of local memory files.
- Profile memory files remain authoritative for `USER.md`, `SOUL.md`, and `MEMORY.md`.
- Shared memory files remain authoritative under global shared memory.
- `promotions.json` remains authoritative for promotion metadata.
- The memory index is always derived and rebuildable.

Local memory disk writes go through the drift-aware `MemoryPersistenceService`. `memory.curate`, `LocalMemoryProvider`, and promotion write/rollback flows use this persistence path instead of placing disk drift checks inside bare `MemoryStore`. The service is a write-safety boundary for authoritative memory files; it is not a retrieval system, memory index, or session search layer.

Protected memory remains protected even when indexed. `SOUL.md` is indexed as protected for parity, status, and rebuild checks, but it is excluded from read/search unless `includeProtected` is true. Semantic recall must never use `SOUL.md`, even if it is indexed, and protected entries must remain excluded from semantic-facing retrieval paths.

Deterministic session search primitives are EstaCoda-native. `SessionDB` does not currently provide Hermes-style `getMessagesAround()` primitives. `SessionSearchService` implements deterministic browse/search/scroll behavior separately from `SessionRecallService`.

## Local Lexical Memory Retrieval

Local memory retrieval is implemented as a deterministic lexical path over authoritative memory files. It is not semantic recall, vector search, embedding retrieval, session search, or a new memory authority layer.

Implemented user/operator-facing surfaces:

| Surface | Boundary |
|---------|----------|
| `memory.read` | Agent-facing bounded local memory read by source/kind |
| `memory.search` | Agent-facing local lexical memory search |
| `estacoda memory index path` | Print the profile-state index path |
| `estacoda memory index status` | Inspect index path, health, and pending rebuild state |
| `estacoda memory index rebuild` | Explicitly rebuild the local lexical memory index |
| `estacoda memory search <query>` | Search local memory lexically from the CLI |
| `estacoda memory read <source>` | Read a bounded local memory source from the CLI |

The local index is a rebuildable mirror. Its profile-state SQLite path is:

```text
<profile-state-dir>/memory-index.sqlite
```

Deleting `memory-index.sqlite` does not delete or mutate authoritative memory files. A missing or unhealthy index is an operator repair problem, not memory loss. Status and rebuild commands are inspection/repair paths for the mirror. If the index is disabled, missing, or unavailable, `memory.read`, `memory.search`, and CLI read/search use safe direct file read or substring search fallback where possible while preserving protected-memory filtering.

Authoritative source boundaries:

- Profile memory files remain authoritative for `USER.md`, `SOUL.md`, and `MEMORY.md`.
- Shared memory files remain authoritative under global shared memory.
- `promotions.json` remains authoritative for promotion metadata.
- `AGENTS.md` is project context, not memory.
- `AGENTS.md` is never indexed as memory.
- The local index is always derived and rebuildable.

Shared memory may be mirrored for lexical retrieval, but the index must preserve its shared/global source boundary. Mirroring shared memory into the index must not convert shared files into profile-local authority or promotion metadata.

Protected memory rules:

- `SOUL.md` is indexed as protected for parity, status, and rebuild checks.
- `SOUL.md` is excluded from `memory.read`, `memory.search`, and CLI read/search unless `includeProtected` or `--include-protected` is explicit.
- Protected excerpts remain bounded.
- Semantic recall must never use protected identity/safety entries.
- Protected entries remain excluded from semantic-facing retrieval paths.

Retrieval output and sizing:

- `memory.read` and `memory.search` accept `maxChars`; the retrieval service bounds it internally.
- `memory.search` accepts `maxResults`; the retrieval service bounds it internally.
- CLI read/search expose bounded sizing flags and use the same local lexical retrieval service.
- `session_search` must not accept `maxChars`; its text-size caps remain system-controlled internally.
- Lexical memory retrieval is deterministic by default.
- Semantic memory retrieval is out of scope for Phase 1.
- Output is redacted, source-labeled, and marked as local memory context, not instruction.
- Missing sources, empty results, fallback use, truncation, redaction, and protected filtering return structured diagnostics without raw memory content in diagnostic fields.
- Returned memory content is context, not a higher-priority instruction. System, developer, repo, `AGENTS.md`, security, and current user instructions still outrank retrieved memory.

CLI read supports these sources:

| Source | Behavior |
|--------|----------|
| `USER.md` | Reads profile user memory |
| `MEMORY.md` | Reads profile learned/project memory |
| `SOUL.md` | Denied unless `--include-protected` is explicit |
| `shared` | Reads global shared memory by key |

Index inspection and repair workflow:

```bash
estacoda memory index path
estacoda memory index status
# Stop the runtime before deleting the index file.
rm <profile-state-dir>/memory-index.sqlite
estacoda memory index status
estacoda memory index rebuild
estacoda memory index status
```

The index is inspectable and deletable. Missing index files report pending rebuild or empty-index diagnostics. Bounded startup backfill may recreate the file. Full rebuild is explicit through `estacoda memory index rebuild`, is idempotent, repopulates from authoritative memory files, and indexes `SOUL.md` as protected.

## Delegation Outcome Memory

Delegation outcome memory is separate from parent/child transcript recall and is disabled by default under `delegation.outcomeMemory.enabled`.

When enabled, delegation records a bounded outcome observation through `MemoryProvider.recordDelegationOutcome(...)`. The record may include parent session id, child session id where one exists, role, depth, task index, batch id, structured status/reason, timestamp, provider token usage, and a bounded preview of the delegated task. `resultSummary` is deterministic status metadata only, such as `completed`, `timeout`, `cancelled`, `skipped: spawn-paused`, or `failed: provider-error`.

Delegation outcome memory must not store raw child output, child transcripts, prompts, tool arguments, file contents, diagnostic payloads, or provider credentials. Recording failure is non-fatal and does not change the delegation result. Child transcripts remain excluded from parent `SessionRecallService`, `session_search`, memory recall, and prompt packing by default.

`session_search` is separate from local memory retrieval. It browses/searches historical sessions and does not expose `maxChars`. `memory.read` and `memory.search` read/search local memory and may expose `maxChars`. Historical session content and memory retrieval results are both context/reference material, not higher-priority instruction.

## Drift-Aware Local Persistence

Local memory writes are protected against silent overwrite of externally edited files. Before writing, `MemoryPersistenceService` compares the loaded disk snapshot with the current disk state. The tracked snapshot includes:

- path
- kind
- `mtimeMs`
- size
- content hash

Save behavior is fail-closed by default:

- Re-stat and read the current file before overwrite.
- Compare current disk state against the loaded snapshot.
- Refuse the write when the file drifted after load.
- Preserve the current disk file on drift refusal.
- Return structured diagnostics without raw memory content.
- Do not create backup files by default.
- Create `.bak.<timestamp>` files only when explicitly configured by the operation policy.

Authoritative memory files remain authoritative. `USER.md`, `SOUL.md`, `MEMORY.md`, shared memory files, and `promotions.json` are still the sources of truth. The persistence service only guards local disk writes; it does not make derived indexes or retrieved session content authoritative.

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

Promotion persistence is fail-closed at the memory layer. If a markdown write fails after promotion metadata changes, `LocalMemoryProvider` rolls back both the markdown content and `promotions.json`. This includes budget overflows, scanner/safety rejections, and other bounded persistence failures after the metadata mutation.

Promotion overflow after an otherwise successful assistant response is non-fatal to the turn. The runtime records a best-effort `memory-promotion-failed` diagnostic with pressure/remediation metadata only; it does not include raw promoted text. Unexpected non-overflow promotion errors still follow the existing fatal policy.

Scanner/safety rejection prevents secret-looking promotion text from being written to memory. A failed promotion must not leave active promotion metadata, and prompt memory rendering must not resurrect rejected or manually deleted entries from stale metadata.

## Memory Tools

The current agent-facing memory write surface is `memory.curate`. It accepts a `kind` value:

| Kind | Description |
|------|-------------|
| `append` | Append a new memory entry |
| `replace` | Replace an existing entry via substring matching (`match`) |
| `remove` | Remove an entry via substring matching (`match`) |

Local lexical retrieval uses separate `memory.read` and `memory.search` tools instead of overloading `memory.curate` with read behavior. These tools are read-only-local surfaces over local memory context; they do not write memory, promote content, or change the prompt authority model.

`memory.read` reads bounded local memory content by source. `memory.search` performs deterministic lexical search. Both tools accept `maxChars`; `memory.search` also accepts `maxResults`. Returned content is redacted, source-labeled, marked as `local-memory-context`, and treated as context rather than instruction. If the local index is disabled or unavailable, the retrieval service uses safe substring read/search fallback while preserving protected filtering.

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

`MemoryBudgetPressure.state === "critical"` is diagnostic only. It does not trigger automatic Memory File Compaction, and other automatic compaction systems use their own thresholds rather than `MemoryBudgetPressure.critical`.

`MemoryStore.apply()` fails closed only on overflow and returns structured overflow metadata to tool callers. Overflow blocks the write; it is not silent. Config numeric coercion for memory-adjacent features is NaN-safe; malformed values fall back to defaults or configured bounds instead of leaking `NaN` into runtime behavior.

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

The service uses the `memory_compaction` auxiliary route. It does not run automatically by default, including when memory-file pressure reaches `critical`. Dry-run mode returns generated compacted text without writing or creating a backup. Applied compaction scans generated output with `MemoryScanner`, writes a timestamped backup under `.memory-file-compaction-backups/`, then writes the compacted file. Restore scans the backup before writing and creates a pre-restore backup of the current file.

Provider failures, missing `memory_compaction` routes, scanner blocks, invalid targets, and write failures fail closed and preserve the original file.

Memory File Compaction is separate from:

- Workflow event summaries (`/workflow summarize <runId>` / `estacoda workflow summarize <runId>`)
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

`SessionRecallService` uses SQLite FTS, groups hits by source session, loads bounded surrounding messages, and uses the auxiliary model route named `session_search` when configured. That auxiliary route is separate from the `session_search` runtime tool described below. If auxiliary summarization is unavailable or fails, recall falls back to deterministic snippets.

Recall is profile-scoped and workspace-scoped when a workspace root is supplied. Sessions with matching workspace metadata are eligible; sessions with non-matching metadata are excluded. Metadata-less legacy sessions are excluded when workspace-scoped recall is active, but may be included in same-profile recall when no workspace root is supplied.

Every recall block is labeled as untrusted historical context and includes source session diagnostics. Recalled content cannot override system, developer, repo, `AGENTS.md`, security, local memory, or current user instructions.

Runtime recall is intentionally narrow. It is only injected for high-confidence continuity language such as "last time", "what did we decide", "what did I say about", "continue from", "we discussed", or relevant "remember ..." phrasing. Ordinary turns do not trigger broad recall.

## Deterministic Session Search Tool

`session_search` is deterministic raw historical session browsing, search, and scroll. It is useful for finding prior sessions or messages, not for deciding current instructions. Historical content returned by the tool is untrusted reference material. Current user instructions, runtime policy, system/developer instructions, repo instructions, `AGENTS.md`, and security policy outrank any historical session content.

The tool uses `SessionSearchService`. It is separate from `SessionRecallService`, does not call auxiliary/model providers, and does not summarize. It does not make historical content authoritative and does not write memory.

Supported modes:

| Mode | Purpose |
|------|---------|
| `browse` | List recent matching sessions |
| `search` | Search raw historical messages |
| `scroll` | Load a deterministic message window around a message id |

Bounds and output rules:

- Output is bounded, redacted, source-labeled, and explicitly marked as untrusted historical reference context.
- Tool output is capped by the fixed registered `maxResultSizeChars`.
- `browse` and `search` expose `limit`; default is `10`, max is `20`.
- `scroll` exposes `window`; default is `5`, max is `20`.
- The tool exposes result/message-count knobs only: `limit` and `window`.
- The schema must not expose `maxChars`.
- Text-size caps, per-message excerpts, and session previews are controlled internally.
- Profile and workspace filtering are applied where available.
- Active/current session exclusion is used where configured or available.
- Missing sessions or messages return structured diagnostics.

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

External recall and mirror-write paths also emit best-effort metadata-only audit events:

| Event | Purpose |
|-------|---------|
| `external-memory-recall` | Records provider id, attempted/enabled state, result count, bounded character totals, warning/failure counts, safe scope metadata, and redacted/bounded failures |
| `external-memory-mirror-write` | Records provider id, mirror enabled/attempted/success state, local write success, safe memory kind/file metadata, bounded entry size, safe scope metadata, and redacted/bounded failures |

These events never store raw recalled content, raw mirrored memory content, credentials, or secrets. Audit event failure is non-fatal, and local memory remains authoritative.

## Agent Evolution Separation

Agent Evolution is separated from memory files:

| Content Type | Destination |
|--------------|-------------|
| Facts/conventions | Profile-local `MEMORY.md` |
| User preferences | Profile-local `USER.md` |
| Persona/identity | Profile-local `SOUL.md` |
| Shared cross-profile knowledge | Global `~/.estacoda/memory/shared/` |
| Reusable procedures | Built-in skills plus profile-local `skills/` |
| Promotion metadata | Profile-local `promotions.json` |

## Session Compression Boundary

Semantic session compression is documented separately in [Semantic Session Compression](./semantic-compression.md). It turns older session context into reference-only summaries; it does not compact `USER.md`, `SOUL.md`, `MEMORY.md`, `AGENTS.md`, shared memory, or promotion metadata.

Compression observability now includes computed summary budgeting, durable anti-thrashing state, ProviderTurnLoop prompt-token diagnostics, fallback diagnostics, and compression-input-only tool-result pruning. The pruning pass can replace old large tool output with bounded redacted placeholders before summarization, but it does not mutate persisted session history or implement broad orphan cleanup.

Transcript-preserving semantic compaction creates explicit session lineage where the caller can adopt a rotated session. Gateway `/compact`, gateway hygiene, and provider-turn automatic compression preserve the original transcript by creating an active compacted child session with `parentSessionId`; the parent keeps its transcript, remains searchable, and is marked ended for `compression`. Interactive CLI `/compact` and top-level `estacoda sessions compact` remain non-rotating in this implementation.

Memory File Compaction is also a separate path. It can compact `USER.md` and `MEMORY.md` only, uses the `memory_compaction` auxiliary route, and remains distinct from semantic session compression and Workflow event summaries.

## Limitations

- External memory has only the file-backed provider in this implementation.
- There is no vector search or embedding store.
- External provider status helpers exist in code, but there is no standalone user-facing external memory status command documented as available.
- Memory File Compaction is manual/tool-driven by default.
