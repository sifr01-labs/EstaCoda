---
title: "Memory"
description: "Memory system: stores, curation, promotion, rendering, and persistence."
---

# Memory

EstaCoda uses bounded, curated memory files that persist across sessions. The system distinguishes between global shared knowledge, profile user preferences, profile identity, profile learned facts, session recall, semantic session compression, and optional external recall.

Memory is durable execution context, so retrieved or generated memory is always subordinate to system, developer, repo, `AGENTS.md`, security, and current user instructions.

## Files

| File | Role |
|------|------|
| `src/memory/memory-store.ts` | Bounded memory file management |
| `src/memory/local-memory-provider.ts` | Read/write memory entries |
| `src/memory/memory-renderer.ts` | Render memory into prompt snapshots |
| `src/memory/memory-prompt-context-builder.ts` | Canonical prompt memory context builder |
| `src/memory/memory-recall-orchestrator.ts` | Per-turn recall and external-memory orchestration |
| `src/memory/memory-promotion.ts` | Promote repeated preferences and facts |
| `src/memory/memory-persistence-service.ts` | Drift-aware local memory write safety |
| `src/tools/memory-tool.ts` | Agent-facing `memory.curate` curation tool |
| `src/memory/memory-index-store.ts` | Profile-state SQLite schema/lifecycle for the local lexical index |
| `src/memory/memory-index.ts` | Local lexical index writes, read/search, status, and vacuum |
| `src/memory/memory-index-sync.ts` | Startup backfill and post-write index sync orchestration |
| `src/memory/memory-retrieval-service.ts` | Bounded local lexical memory read/search with fallback |
| `src/cli/memory-commands.ts` | CLI memory index/read/search commands |
| `src/tools/memory-retrieval-tools.ts` | Agent-facing `memory.read` and `memory.search` tools |
| `src/memory/memory-file-compaction-service.ts` | Manual memory-file compaction and restore service |
| `src/memory/memory-fact-extractor.ts` | Structured durable-fact extraction over transcript slices |
| `src/memory/memory-reviewer.ts` | Deterministic memory curation policy gate |
| `src/memory/memory-curation-service.ts` | Runtime memory curation checkpoints and auto-apply orchestration |
| `src/memory/memory-curation-store.ts` | Profile-local curation history store |
| `src/memory/memory-operator-commands.ts` | Shared CLI/slash/gateway memory curation controls |
| `src/memory/external-memory-provider.ts` | External memory lifecycle helpers and file-backed provider |
| `src/session/session-search-service.ts` | Deterministic raw session browse/search/scroll |

## Memory Files

| File | Purpose | Char Limit | Location |
|------|---------|------------|----------|
| `memory/shared/` | Global shared memory snippets | Bounded by renderer | `~/.estacoda/memory/shared/` |
| `USER.md` | Profile user preferences and communication style | 1,375 (~500 tokens) | `~/.estacoda/profiles/<id>/USER.md` |
| `SOUL.md` | Profile agent identity and personality | Configurable | `~/.estacoda/profiles/<id>/SOUL.md` |
| `MEMORY.md` | Profile facts, conventions, and lessons | 2,200 (~800 tokens) | `~/.estacoda/profiles/<id>/MEMORY.md` |

`profiles/<id>/promotions.json` stores promotion metadata for that profile. There is no global `USER.md` and no global promotion store.

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

Deterministic session search primitives are EstaCoda-native. `SessionDB` does not currently provide `getMessagesAround()` primitives. `SessionSearchService` implements deterministic browse/search/scroll behavior separately from `SessionRecallService`.

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

## Memory Curation

Memory curation is the proactive learned-memory path for v0.2.0. It reviews transcript slices at natural checkpoints, extracts structured durable facts, applies deterministic policy in code, and writes only low-risk auto-approved candidates to profile-local memory files.

The extractor uses the existing semantic compression auxiliary route when available, falling back through the existing auxiliary execution path. It does not use the memory-file compaction route. The model extracts facts with evidence; runtime policy decides whether to auto-apply, queue for review, or ignore.

Implemented checkpoints:

- every configured `memory.curation.checkpointEveryTurns` completed root-session turns
- `/compact` and manual session compaction when enabled
- `/handoff` when enabled
- explicit `memory populate` / `/memory populate`

Semantic session endings use durable background finalization instead of running curation inside generic runtime disposal. The CLI enqueues the completed session for `/new`, `/reset`, `/exit`, idle `Ctrl+C`, and a successful one-shot prompt. Authorized gateway `/new` and `/reset` commands enqueue the old channel session. Active-turn `Ctrl+C` only cancels that turn; config refresh, runtime-cache eviction, cron cleanup, and generic `Runtime.dispose()` do not enqueue finalization.

Enqueue captures an immutable message-count/message-id cutoff in the global, profile-scoped `~/.estacoda/sessions.sqlite` queue. It stores identifiers, reason, status, attempts, timestamps, and bounded outcome/error codes, not transcript content. The new session or exit waits only for this durable database write, not model extraction or memory writes. A failed enqueue emits one bounded warning and does not block the transition.

The managed gateway supervisor claims queued work in the background. First-run setup offers this service even when no channel is configured. A profile lease permits one durable memory mutation per profile across checkpoints, `memory.curate`, automatic promotion, operator writes, and memory-file compaction or restore. Compaction refreshes the canonical file after acquiring the lease and persists through the drift-aware memory path. Expired jobs are recoverable, and extraction or apply failures leave the source cursor unchanged so bounded retry can revisit the same messages before a terminal state. The worker retains only the latest 1,000 terminal rows per profile. If no gateway service is running, work remains durable until a gateway for that profile runs. Finalization reads only through the captured cutoff and uses the originating session workspace, so later messages and another gateway workspace cannot change its scope.

Default curation mode is `auto`. Auto mode still applies only explicit, non-sensitive, low-risk facts that pass evidence, duplicate, scanner, and budget gates. `review` mode records pending-review audit records without mutating memory. `manual` mode skips background checkpoints and only runs explicit manual commands.

Operator controls are shared across CLI, in-session slash commands, and authorized gateway surfaces such as Telegram:

```text
estacoda memory mode [auto|review|manual]
estacoda memory recent [--limit N]
estacoda memory review [--limit N]
estacoda memory apply <record-id> [candidate-id|all]
estacoda memory reject <record-id> [candidate-id|all]
estacoda memory undo <record-id>
estacoda memory forget <USER.md|MEMORY.md> <exact text>
estacoda memory populate
estacoda memory edit
estacoda memory clear [USER.md|MEMORY.md|all] --yes
estacoda memory finalization list [--status pending|running|completed|failed] [--limit N]
estacoda memory finalization retry <job-id>
estacoda memory finalization prune [--keep N]
```

The corresponding in-session and Telegram commands use `/memory ...` with the same subcommands. Telegram output is compact, but the policy and profile-local files are the same as the CLI.

`memory apply`, `memory undo`, and `memory forget` use the same memory mutation path as `memory.curate` and auto-curation, including drift checks, scanner/budget gates, index sync, and configured external-memory mirror warnings. `memory clear` is guarded by `--yes`, clears only `USER.md` and/or `MEMORY.md`, creates backups for existing files, syncs the local memory index, and never clears `SOUL.md` or shared memory. Existing live sessions may need `/new` or restart to reload prompt memory after file edits or clears.

`estacoda memory status` and `estacoda gateway status` report profile-scoped `pending`, `running`, `retrying`, and `failed` finalization counts. Top-level `memory finalization` commands inspect bounded job metadata, including terminal outcome/error codes, requeue failed work, and prune terminal metadata; they are not exposed as remote `/memory` mutations. Checkpoints, `memory.curate`, automatic promotions, operator writes, and memory-file compaction or restore share the profile curation lease and may report that memory is busy while a background finalizer is writing.

Curation history lives at:

```text
~/.estacoda/profiles/<id>/memory-curation.json
```

The history stores audit metadata, source message ids/counts, extracted fact ids, operation hashes, reasons, and reversible low-risk operation payloads for applied or reviewable candidates. `memory review` is an actionable queue for candidates that store an operation; sensitive or higher-risk candidates remain visible as non-applyable review records. Durable writes remain visible through recent history, session/runtime events, and the authoritative memory files.

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

## Delegation Telemetry

Delegation outcomes are operational telemetry. They belong in session events and trajectory records, not canonical prompt memory.

`MEMORY.md` must not store delegation status lines, child output, child transcripts, prompts, tool arguments, file contents, diagnostic payloads, or provider credentials. Child transcripts remain excluded from parent `SessionRecallService`, `session_search`, memory recall, and prompt packing by default.

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

Checkpoint memory curation uses the same local persistence boundaries, but it is not a model-visible tool call. The runtime extracts facts from transcript slices, applies policy in code, then writes eligible `USER.md` / `MEMORY.md` operations or records review/ignore history in `memory-curation.json`.

## Promotion

`memory-promotion.ts` runs after the response path and uses **bounded session search** instead of scanning every session/message.

**Promoted content types:**

| Type | Destination | Evidence |
|------|-------------|----------|
| Repeated user preferences | `USER.md` | `smoke-tested` |
| Repeated project facts | `MEMORY.md` | `smoke-tested` |
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

`memory.curate` can write `USER.md`, `MEMORY.md`, and `SOUL.md`. Checkpoint curation writes only learned-memory targets, `USER.md` and `MEMORY.md`. Neither path manages `AGENTS.md`. If external memory mirror writes are enabled, local writes remain authoritative and mirror failures are returned as warnings without failing the local write.

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
- mirror shared memory mutation writes when `mirrorWrites: true`
- expose provider status through internal provider status helpers

The external memory contract also defines `afterTurn` and `flushSession` hooks, and the file-backed provider implements safe handlers for them. These hooks are reserved for future orchestration unless a caller invokes them directly; current runtime orchestration does not actively call them. Implemented runtime paths are external recall and opt-in mirror writes for shared memory mutations, including `memory.curate`, auto-curation, and operator apply/undo/forget actions.

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
