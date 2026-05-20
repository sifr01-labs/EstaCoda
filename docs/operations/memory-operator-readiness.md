---
title: "Memory Operator Readiness"
description: "Operational guide for the Phase 0-10 Memory Hardening implementation."
---

# Memory Operator Readiness

This guide summarizes the implemented Memory Hardening behavior for operators and reviewers. It documents shipped behavior only.

## Inventory

Canonical docs updated for Memory Hardening:

- [Memory](../subsystems/memory.md) — local memory, prompt builder, orchestrator, recall, Memory File Compaction, external memory.
- [Semantic Session Compression](../subsystems/semantic-compression.md) — `/compact`, `estacoda sessions compact`, gateway hygiene, fallback, and events.
- [Providers](../subsystems/providers.md) — auxiliary route boundaries and file-backed external memory config.
- [Security](../subsystems/security.md) — trust boundaries for memory, recall, compression, and external providers.
- [CLI & Onboarding](../subsystems/cli.md) and [Operator Controls](./operator-controls.md) — implemented command surfaces.

## Feature Map

| Phase | Implemented surface | Operator note |
|-------|---------------------|---------------|
| 0A | `AGENTS.md` removed from memory contracts | It remains project context only. |
| 0B/1 | `MemoryPromptContextBuilder` | One prompt memory contract prevents duplicate `USER.md` / `MEMORY.md` injection. |
| 3 | Memory budget pressure and NaN-safe config coercion | Overflow fails closed with structured metadata using `kind`, `chars`, and `maxChars`. |
| 4 | Memory File Compaction tools | Manual/tool-driven by default; targets only `USER.md` / `MEMORY.md`. |
| 5 | Manual session recall | `estacoda session(s) recall <query>` and slash recall where runtime surfaces are present. |
| 6 | High-confidence runtime recall | `AgentLoop -> MemoryRecallOrchestrator -> SessionRecallService` owns recall; ordinary turns do not trigger broad recall. |
| 7 | Semantic session compression | Experimental/default-off; `/compact`, `sessions compact`, gateway hygiene. |
| 8 | `MemoryRecallOrchestrator` | Owns per-turn local/session/external recall decisions and diagnostics. |
| 9 | External provider lifecycle hooks | Contract is present; active runtime paths are recall and opt-in mirror writes. `afterTurn` and `flushSession` are reserved hooks and are not actively invoked by runtime orchestration. |
| 10 | File-backed external memory provider | Profile-local JSONL storage beneath `external-memory/`. |

## Enabling And Disabling

Semantic session compression is off unless both gates are set:

```json
{
  "compression": {
    "enabled": true,
    "experimental": true,
    "threshold": 0.5,
    "targetRatio": 0.2,
    "protectFirstN": 3,
    "protectLastN": 20
  }
}
```

External memory is off unless a provider id is set:

```json
{
  "externalMemory": {
    "enabled": true,
    "provider": "file",
    "maxResults": 3,
    "maxChars": 2500,
    "mirrorWrites": false,
    "file": {
      "path": "external-memory.jsonl",
      "maxEntries": 1000
    }
  }
}
```

`externalMemory.file.path` is relative to the selected profile's `external-memory/` directory. Absolute paths and paths escaping that directory are rejected.

Memory File Compaction is manual/tool-driven by default. It requires a configured `auxiliaryModels.memory_compaction` route to generate compacted content.

## Commands And Tools

Implemented user-facing commands:

```bash
estacoda session recall <query>
estacoda sessions recall <query>
estacoda sessions compact <session-id> [--topic <topic>]
```

Implemented interactive slash surfaces where the runtime exposes them:

```text
/session recall <query>
/sessions recall <query>
/compact [topic]
/flow compact <flowId>
```

Implemented gateway slash surface from this set:

```text
/compact [topic]
```

Implemented memory runtime tools:

```text
memory.file_compact
memory.file_compaction_restore
memory.curate
```

`memory.curate` is the implemented memory write surface. Its `kind` field accepts `append`, `replace`, or `remove`; docs should not treat a generic `add` memory action as an available command or tool.

There is no top-level memory prompt, memory compact, or memory restore-backup CLI command in this implementation. Use the runtime tools for Memory File Compaction and restore.

## Diagnostics

Memory diagnostics appear in prompt context diagnostics, session events, trajectory events, and command output depending on the surface.

Memory budget pressure reports the implemented `MemoryBudgetPressure` contract: `kind`, `source`, `chars`, `maxChars`, `ratio`, `percent`, `state`, `remainingChars`, and `overflowChars`. Earlier planning names for file kind and character budget are not the implemented field names.

Key event kinds:

- `session-recall-decision` — why runtime recall was or was not injected.
- `memory-file-compaction` — memory-file compaction dry-run/apply/restore metadata.
- `session-history-compressed` — semantic session compression source/protection/fallback details.
- `session-compression-state` — latest semantic compression state for runtime rehydration.

Compression command output reports message counts, token estimates, optional focus topic, fallback status, and warnings.

## Troubleshooting

Auxiliary `session_search` failure:

- Manual/session recall falls back to deterministic snippets.
- Check `auxiliaryModels.session_search` and provider credentials.
- Recalled content remains untrusted either way.

Auxiliary `compression` failure:

- Semantic compression falls back to deterministic packing.
- Warnings are returned in `/compact` / `sessions compact` output and prompt diagnostics.
- Check `compression.experimental`, `compression.enabled`, `auxiliaryModels.compression`, and provider credentials.

Memory File Compaction failure:

- Missing `memory_compaction` route returns `memory-file-compaction-route-unavailable`.
- Scanner-blocked output preserves the original file.
- Provider failures preserve the original file.
- Applied compactions create backups before writes; restore uses `memory.file_compaction_restore`.

External memory failure:

- Local memory remains authoritative.
- Recall/mirror failures are warnings.
- Verify `externalMemory.enabled`, `externalMemory.provider`, relative file path, and profile directory permissions.
- There is no standalone external memory status CLI command in this implementation.

Gateway hygiene:

- Runs only for normal gateway turns, after session ID resolution and before runtime acquisition.
- Skips gateway commands such as `/compact`, `/help`, and `/status`.
- Uses semantic session compression with `trigger: "hygiene"`.

## Security Review Checklist

Before merge or release, inspect:

- `AGENTS.md` appears only as project context, not memory.
- `SOUL.md` cannot be compacted or suppressed by learned-memory filtering.
- Session recall is bounded, profile-scoped, and workspace-scoped when a workspace root is supplied.
- Metadata-less legacy sessions are excluded from workspace-scoped recall.
- Recalled, compressed, and external memory is labeled untrusted.
- External memory is disabled by default and cannot write outside profile-local `external-memory/`.
- Mirror writes are opt-in and redact secret-looking payloads.
- Memory File Compaction creates backups and scans generated content before writes.
- Semantic compression is experimental/default-off and preserves protected head/tail/latest-user/tool-pair context.
- TaskFlow compaction remains separate from bare `/compact`.

## Rollout Guidance

Use a conservative rollout:

1. Keep semantic compression disabled until local validation and dogfood are green.
2. Enable manual `/compact` first, then gateway hygiene.
3. Keep external memory disabled unless the file-backed provider is explicitly needed.
4. Review warnings from recall, compaction, compression, and mirror writes before broad use.
5. Run `pnpm run typecheck`, `pnpm run test`, `pnpm run smoke`, and `git diff --check` before merging documentation or runtime changes.
