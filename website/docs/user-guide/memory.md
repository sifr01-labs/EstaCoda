---
title: Memory
description: Memory files, promotion, curation, and compaction boundaries for v0.1.0.
sidebar_position: 7
---

# Memory

EstaCoda uses bounded, curated memory files that persist across sessions. Memory is durable execution context, but it is subordinate to system instructions, developer instructions, repo context, `AGENTS.md`, security policy, and the current user request.

This page explains what memory files exist, how they are populated, and where the boundaries are.

---

## Memory Files

Memory lives in two scopes: profile-local and global shared.

### Profile-Local Memory

`~/.estacoda/profiles/<id>/` contains:

| File | Purpose | Char Budget |
|---|---|---|
| `USER.md` | User preferences and communication style | 1,375 (~500 tokens) |
| `SOUL.md` | Agent identity and personality | Configurable |
| `MEMORY.md` | Facts, conventions, and lessons | 2,200 (~800 tokens) |
| `promotions.json` | Promotion metadata | — |

`AGENTS.md` is **not** a memory file. It is project context loaded from the workspace. It is never curated, compacted, promoted, or recalled as learned memory.

Render order in the prompt:

```text
memory/shared/ -> USER.md -> SOUL.md -> MEMORY.md
```

### Global Shared Memory

`~/.estacoda/memory/shared/` holds snippets available to all profiles. It is bounded by the renderer and loaded before profile-local memory.

---

## Local Lexical Retrieval

Local lexical memory retrieval is implemented as deterministic read/search over authoritative memory files. It is not semantic recall, vector search, session search, or a new memory authority layer.

Implemented user/operator-facing surfaces:

| Surface | Purpose |
|---|---|
| `memory.read` | Read bounded local memory content by memory source/kind |
| `memory.search` | Search local memory content lexically |
| `estacoda memory index path` | Show the profile-state index path |
| `estacoda memory index status` | Inspect local index path, health, and pending rebuild state |
| `estacoda memory index rebuild` | Explicitly rebuild the local lexical memory index |
| `estacoda memory search <query>` | Search local memory from the CLI |
| `estacoda memory read <source>` | Read local memory from the CLI |

The local lexical index is a rebuildable mirror stored under profile state:

```text
<profile-state-dir>/memory-index.sqlite
```

Deleting this SQLite file does not delete `USER.md`, `SOUL.md`, `MEMORY.md`, shared memory files, or `promotions.json`. Index status and rebuild commands are operator repair paths for the mirror. If the index is disabled, missing, or unavailable, `memory.read`, `memory.search`, and CLI read/search fall back to safe direct file read or substring search where possible while preserving protected-memory filtering.

Authoritative source boundaries:

- `USER.md`, `SOUL.md`, and `MEMORY.md` remain profile-local source files.
- Shared memory files remain authoritative under global shared memory.
- `promotions.json` remains authoritative for promotion metadata.
- `AGENTS.md` is not memory and is never indexed as memory.
- Shared memory may be mirrored for lexical retrieval, but the index must preserve its shared/global source boundary.

Protected identity/safety memory remains protected. `SOUL.md` is indexed as protected for parity, status, and rebuild checks, but `memory.read`, `memory.search`, and CLI read/search exclude it unless `includeProtected` or `--include-protected` is explicit. Protected excerpts remain bounded. Semantic recall must never use protected identity/safety entries, and protected entries remain excluded from semantic-facing retrieval paths.

`memory.read` and `memory.search` accept `maxChars` because they return memory content directly; the service bounds it internally. `memory.search` accepts bounded `maxResults`. `session_search` must not accept `maxChars`; its text-size caps remain system-controlled internally. Returned memory content is redacted, source-labeled, marked as local memory context, and is not a higher-priority instruction. Missing sources and empty results return structured diagnostics.

CLI read supports:

- `USER.md`
- `MEMORY.md`
- `SOUL.md` only with `--include-protected`
- `shared` memory by key

Operator recovery workflow:

```bash
estacoda memory index path
estacoda memory index status
# Stop the runtime before deleting the index file.
rm <profile-state-dir>/memory-index.sqlite
estacoda memory index status
estacoda memory index rebuild
estacoda memory index status
```

Missing index files report pending rebuild or empty diagnostics. Bounded startup backfill may recreate the file. Full rebuild is explicit through `estacoda memory index rebuild`, is idempotent, repopulates from authoritative memory files, and indexes `SOUL.md` as protected.

---

## Trusted Learned Memory vs. Untrusted Recall

Not all memory is treated the same way.

**Trusted learned memory** — `USER.md`, `SOUL.md`, `MEMORY.md`, and shared memory. These are curated files the operator controls. They are injected as system context.

**Untrusted historical context** — session recall, external recall, and semantic compression summaries. These are reference-only. They are labeled as historical and cannot override system instructions, `AGENTS.md`, security policy, local memory, or the current user request.

Authority order:

```text
system/developer/repo/AGENTS/security/current user instructions > learned memory > reference-only recall/compression context
```

---

## Memory Write Safety

Memory writes are not unconditional. The system checks for:

- **Prompt-injection patterns** — blocked before write.
- **Secret/API-key markers** — text that looks like credentials is rejected.
- **Invisible/bidirectional controls** — malformed or suspicious control characters are sanitized or rejected.

If a write fails the safety check, it is rejected and the file is not modified. Promotion overflow after an otherwise successful assistant response is non-fatal to the turn; a best-effort diagnostic is recorded without raw promoted text or secrets.

Local memory writes also use drift-aware persistence. Before overwrite, the persistence path compares the current disk file against the snapshot loaded earlier. The snapshot includes path, memory kind, `mtimeMs`, size, and content hash. External edits fail closed by default, and drift refusal preserves the current disk file. `.bak.<timestamp>` backups are not created by default; they are created only when an operation policy explicitly enables them. Drift diagnostics do not expose raw memory content.

---

## Promotion

After each turn, `memory-promotion.ts` scans bounded session history for repeated patterns:

| Pattern | Destination |
|---|---|
| Repeated user preferences | `USER.md` |
| Repeated project facts | `MEMORY.md` |
| Skill outcomes | Memory store |
| Manual conclusions | Memory store |

Promotion handles contradictions (replacing outdated entries), strengthening (reinforcing existing entries), and forgetting (removing obsolete entries). If a markdown write fails after promotion metadata changes, `LocalMemoryProvider` rolls back both the markdown content and `promotions.json`.

Promotion is **not** automatic self-healing. It is bounded, scanned, and fail-closed.

---

## External Memory

External memory is **disabled by default**. The only implemented provider is file-backed and profile-local.

When enabled under `externalMemory`, it stores JSONL records beneath the selected profile's `external-memory/` directory. It can:

- Return bounded untrusted external recall for explicit recall turns.
- Mirror `memory.curate` writes when `mirrorWrites: true`.

It cannot replace `USER.md`, `MEMORY.md`, `SOUL.md`, shared memory, or session recall. It cannot use absolute storage paths or write outside the profile's `external-memory/` directory.

Audit events for external recall and mirror writes are metadata-only. They never store raw recalled content, raw mirrored memory content, credentials, or secrets.

---

## Session Compression

Semantic session compression is **experimental-only** in v0.1.0. It is **disabled by default** and requires both gates:

```json
{
  "compression": {
    "enabled": true,
    "experimental": true
  }
}
```

Unless both `compression.enabled` and `compression.experimental` are `true`, semantic compression does not run. There is no default-on path.

When enabled, compression turns older session history into reference-only summaries. It does not compact `USER.md`, `SOUL.md`, `MEMORY.md`, `AGENTS.md`, shared memory, or promotion metadata. Compressed summaries are untrusted historical context.

Manual compression is available via `/compact [topic]` or `estacoda sessions compact <session-id>`. Gateway `/compact` preserves the parent transcript by creating a compacted child session. CLI `/compact` remains non-rotating in this implementation.

---

## Memory File Compaction

Memory File Compaction compacts `USER.md` and `MEMORY.md`. It does not compact `SOUL.md`, `AGENTS.md`, shared memory, or session history. It uses the `memory_compaction` auxiliary route.

Tools:

- `memory.file_compact` — manually compact a file; supports `dryRun`.
- `memory.file_compaction_restore` — restore from a compaction backup.

Applied compaction creates a timestamped backup under `.memory-file-compaction-backups/` before writing. Critical memory-file pressure is diagnostic only; it does not trigger automatic compaction.

---

## The Memory Curation Tool

The agent-facing memory write surface is `memory.curate`. It accepts:

| Kind | Action |
|---|---|
| `append` | Append a new entry |
| `replace` | Replace an existing entry by substring match |
| `remove` | Remove an entry by substring match |

Local lexical retrieval uses separate `memory.read` and `memory.search` tools instead of adding read behavior to `memory.curate`. These tools read/search local memory context only. They do not write memory, promote content, or change instruction priority.

---

## Inspection, Backup, and Recovery

```bash
# Inspect and repair the local lexical index
estacoda memory index path
estacoda memory index status
estacoda memory index rebuild

# Search/read local memory from the CLI
estacoda memory search <query>
estacoda memory read USER.md
estacoda memory read MEMORY.md
estacoda memory read shared <key>
estacoda memory read SOUL.md --include-protected

# Check memory budget pressure
# (surfaced in diagnostics; no standalone CLI for v0.1.0)

# Compact a memory file (via runtime tool)
# memory.file_compact target=USER.md dryRun=true

# Restore from backup (via runtime tool)
# memory.file_compaction_restore target=USER.md
```

Memory files are plain Markdown. You can back them up manually:

```bash
cp ~/.estacoda/profiles/<id>/USER.md ~/.estacoda/profiles/<id>/USER.md.bak
cp ~/.estacoda/profiles/<id>/MEMORY.md ~/.estacoda/profiles/<id>/MEMORY.md.bak
```

Do not edit `promotions.json` blindly. It tracks active promotion metadata. If it drifts from the markdown files, memory rendering may resurrect stale or rejected entries.

---

## Failure Modes

**Promotion overflow:** Non-fatal to the turn. Diagnostic recorded with pressure metadata only. No raw text or secrets included.

**Scanner rejection:** Write blocked. Original file preserved. No active promotion metadata left behind.

**Memory File Compaction failure:** Original file preserved. Missing `memory_compaction` route returns `memory-file-compaction-route-unavailable`.

**External memory failure:** Local memory remains authoritative. Failures surface as warnings.

---

## Related

- [Architecture](../developer/architecture.md) — system structure and state boundaries
- [Runtime](../developer/runtime.md) — runtime creation and memory prompt assembly
- [Security and Approvals](./security-and-approvals.md) — memory trust boundaries
