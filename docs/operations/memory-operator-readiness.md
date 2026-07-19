---
title: "Memory Operator Readiness"
description: "Operational guide for the Phase 0-10 Memory Hardening implementation."
---

# Memory Operator Readiness

This guide summarizes the implemented Memory Hardening behavior for operators and reviewers. It documents shipped behavior only.

## Inventory

Canonical docs updated for Memory Hardening:

- [Memory](../subsystems/memory.md) — local memory, curation, prompt builder, orchestrator, recall, Memory File Compaction, external memory.
- [Semantic Session Compression](../subsystems/semantic-compression.md) — `/compact`, `estacoda sessions compact`, gateway hygiene, fallback, and events.
- [Providers](../subsystems/providers.md) — auxiliary route boundaries and file-backed external memory config.
- [Security](../subsystems/security.md) — trust boundaries for memory, recall, compression, and external providers.
- [CLI & Setup](../subsystems/cli.md) and [Operator Controls](./operator-controls.md) — implemented command surfaces.

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
| 9 | External provider lifecycle hooks | Contract is present; active runtime paths are recall and opt-in mirror writes. `afterTurn` and `flushSession` are reserved hooks and are not actively invoked by runtime orchestration. External recall and mirror-write attempts emit metadata-only audit events best-effort. |
| 10 | File-backed external memory provider | Profile-local JSONL storage beneath `external-memory/`. |
| Curation | Checkpoint memory curation | Extracted facts are reviewed by runtime policy, then auto-applied, queued for review, or ignored. Default mode is conservative `auto`. |

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

Memory curation is enabled by default in conservative auto mode:

```json
{
  "memory": {
    "curation": {
      "mode": "auto",
      "checkpointEveryTurns": 25,
      "auditOnCompact": true,
      "auditOnHandoff": true,
      "auditOnRuntimeDispose": true,
      "autoApplyMaxRisk": "low",
      "autoApplyMinConfidence": 0.7,
      "autoWriteVisibility": "activity"
    }
  }
}
```

Use `estacoda memory mode review` for a fully inspectable pending-review workflow, or `estacoda memory mode manual` to skip background checkpoints.

`auditOnRuntimeDispose` and the `runtimeDisposeMin*` fields are compatibility keys. They now gate durable curation for semantic session endings, not arbitrary runtime disposal. `/new`, `/reset`, `/exit`, idle `Ctrl+C`, authorized channel `/new` or `/reset`, and successful one-shot prompts enqueue an immutable session cutoff without waiting for extraction. Active-turn `Ctrl+C` is cancellation-only.

The selected profile's managed gateway service processes queued finalization jobs. First-run setup offers service activation even for CLI-only configurations. Jobs remain durably profile-scoped in global `~/.estacoda/sessions.sqlite` while the service is stopped, then resume when a gateway for that profile runs. `estacoda memory status` and `estacoda gateway status` expose `pending`, `running`, `retrying`, and `failed` counts without transcript content. Use `estacoda memory finalization list --status failed` to inspect bounded failure metadata, `retry <job-id>` to reset a failed job's attempt budget, and `prune --keep N` to reduce terminal metadata. The worker automatically retains the latest 1,000 terminal rows per profile.

Memory File Compaction is manual/tool-driven by default. It requires a configured `auxiliaryModels.memory_compaction` route to generate compacted content. Memory-file critical pressure is diagnostic only; it does not trigger automatic Memory File Compaction. Overflow fails closed with structured errors. Other auto-compaction paths use their own thresholds, not `MemoryBudgetPressure.critical`.

## Commands And Tools

Implemented user-facing commands:

```bash
estacoda session recall <query>
estacoda sessions recall <query>
estacoda sessions compact <session-id> [--topic <topic>]
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
```

Implemented interactive slash surfaces where the runtime exposes them:

```text
/session recall <query>
/sessions recall <query>
/compact [topic]
/workflow summarize <runId>
/memory mode [auto|review|manual]
/memory recent [limit]
/memory review [limit]
/memory apply <record-id> [candidate-id|all]
/memory reject <record-id> [candidate-id|all]
/memory undo <record-id>
/memory forget <USER.md|MEMORY.md> <exact text>
/memory populate
/memory edit
```

Implemented gateway slash surface from this set:

```text
/compact [topic]
/memory mode [auto|review|manual]
/memory recent [limit]
/memory review [limit]
/memory apply <record-id> [candidate-id|all]
/memory reject <record-id> [candidate-id|all]
/memory undo <record-id>
/memory forget <USER.md|MEMORY.md> <exact text>
/memory populate
/memory edit
```

Implemented memory runtime tools:

```text
config.compression.status
memory.file_compact
memory.file_compaction_restore
memory.curate
```

`memory.curate` is the implemented memory write surface. Its `kind` field accepts `append`, `replace`, or `remove`; docs should not treat a generic `add` memory action as an available command or tool.

Memory curation operator commands are not raw `memory.curate` calls. They run the shared curation pipeline and write profile-local history to `memory-curation.json`. `memory review` is an actionable queue for stored low-risk candidate operations; `memory apply`, `memory reject`, `memory undo`, and `memory forget` use the shared mutation path with drift checks, scanner/budget gates, index sync, and configured external-memory mirror warnings.

`config.compression.status` is read-only. It reports normalized semantic compression config, auxiliary `compression` route status, and latest session compression state/event summary where a session context is available. It does not enable compression, write config, append session events, expose raw summaries, or expose credentials. There is no `config.compression.setup` command or tool.

There is no top-level memory prompt, memory compact, or memory restore-backup CLI command in this implementation. Use the runtime tools for Memory File Compaction and restore.

Surface-specific session compaction behavior:

- Gateway `/compact [topic]` preserves the parent transcript by creating a compacted child session and adopting that child as the active channel session.
- Gateway hygiene also preserves transcripts. It runs before runtime acquisition, creates/adopts the child when compaction rotates, and then acquires the runtime for the child session.
- Provider-turn automatic compression rotates at the `AgentLoop` boundary before provider prompt assembly. `ProviderTurnLoop` reads the active child session and does not perform persistent session forking itself.
- Interactive CLI `/compact [topic]` and top-level `estacoda sessions compact <session-id>` remain non-rotating because those surfaces do not yet adopt child sessions.

## Diagnostics

Memory diagnostics appear in prompt context diagnostics, session events, trajectory events, and command output depending on the surface.

Memory budget pressure reports the implemented `MemoryBudgetPressure` contract: `kind`, `source`, `chars`, `maxChars`, `ratio`, `percent`, `state`, `remainingChars`, and `overflowChars`. Earlier planning names for file kind and character budget are not the implemented field names.

Key event kinds:

- `session-recall-decision` — why runtime recall was or was not injected.
- `memory-promotion-failed` — best-effort promotion overflow diagnostic with safe pressure/remediation metadata and no raw promoted text.
- `memory-file-compaction` — memory-file compaction dry-run/apply/restore metadata.
- `session-history-compressed` — semantic session compression source/protection/fallback details.
- `session-compression-state` — latest semantic compression state for runtime rehydration.
- `external-memory-recall` — metadata-only external provider recall audit.
- `external-memory-mirror-write` — metadata-only external provider mirror-write audit.
- `session-compaction-forked` — best-effort parent-side lineage/audit event when preserving semantic compaction creates a child.
- `memory-curation` — checkpoint trigger/status, source counts, extracted fact count, operation count, and warning metadata without raw candidate content.
- background finalization status — profile-scoped pending/running/retrying/failed queue counts from `memory status` and `gateway status`, without message content.

Compression command output reports message counts, token estimates, optional focus topic, fallback status, and warnings.

Semantic compression observability includes `compressionCount`, redacted/bounded `previousSummary`, `lastCompressedThroughMessageId`, `lastPromptTokensEstimated`, `lastActualPromptTokens`, `lastCompressionSavingsPct`, `ineffectiveCompressionCount`, `summaryFailureCooldownUntil`, `recentSavingsRatios`, `sourceMessageCount`, `protectedMessageCount`, `summaryLengthTokens`, `droppedMessageCount`, `modelUsed`, `auxModelFailure`, `mainRetryFailure`, `fallbackUsed`, and `fallbackReason` where available. These fields are for operational diagnosis; they do not contain raw full transcripts.

Summary budgeting is computed from the source messages being summarized. The target budget uses rough token estimation, `compression.targetRatio`, a `2,000` token minimum, a 5% context cap, and a `12,000` token ceiling. Provider generation requests add `1.3x` headroom above the target budget, so operators should distinguish the target summary budget from provider `maxTokens`.

Anti-thrashing state is durable. Two consecutive compressions saving less than 10% cause automatic semantic compression to skip until a higher-savings compression resets the count or a manual `/compact [topic]` bypasses the gate. The skip applies only to semantic compression; deterministic history packing remains available.

Provider-turn compression diagnostics may include the assembled prompt token estimate and actual provider input tokens when the provider reports usage. Missing usage is normal for some providers and does not fail the turn.

Preserved semantic compaction creates explicit session lineage. The child session stores `parentSessionId`, receives the compacted transcript, and stores compression events/state. The parent session keeps its original transcript, remains searchable/queryable for audit, and is marked with `endedAt` plus `endReason: "compression"` only after the child transcript write succeeds. Gateway runtime rotation is adopted on both success and error paths so later turns do not resume an ended parent.

## Troubleshooting

Auxiliary `session_search` failure:

- Manual/session recall falls back to deterministic snippets.
- Check `auxiliaryModels.session_search` and provider credentials.
- Recalled content remains untrusted either way.

Auxiliary `compression` failure:

- Semantic compression tries the auxiliary `compression` route first. If allowed by route configuration, it may retry on the main route. If model summarization fails, it falls back to deterministic packing.
- Static emergency marker text is reserved for cases where deterministic packing cannot fit.
- Warnings are returned in `/compact` / `sessions compact` output and prompt diagnostics.
- Check `compression.experimental`, `compression.enabled`, `auxiliaryModels.compression`, and provider credentials.

Memory File Compaction failure:

- Missing `memory_compaction` route returns `memory-file-compaction-route-unavailable`.
- Critical memory-file pressure is diagnostic only and does not start compaction by itself.
- Overflow blocks the write with structured pressure metadata; it does not self-heal or silently compact.
- Scanner-blocked output preserves the original file.
- Provider failures preserve the original file.
- Applied compactions create backups before writes; restore uses `memory.file_compaction_restore`.

Promotion persistence failure:

- Budget overflow after an otherwise successful response is non-fatal to the user turn.
- The runtime records a best-effort `memory-promotion-failed` diagnostic with provider, target file/kind, pressure, reason, and remediation metadata where available.
- Promotion diagnostics must not include raw promoted text or secrets.
- `LocalMemoryProvider` rolls back markdown and promotion metadata if promotion persistence fails.
- Scanner/safety rejection prevents secret-looking text from being written to memory and must not leave active promotion metadata.
- Unexpected non-overflow promotion errors still follow the existing fatal policy.

External memory failure:

- Local memory remains authoritative.
- Recall/mirror failures are warnings.
- `external-memory-recall` and `external-memory-mirror-write` audit events are best-effort and metadata-only. They never store raw recalled content or raw mirrored memory content, and event write failure does not fail local memory or recall.
- Verify `externalMemory.enabled`, `externalMemory.provider`, relative file path, and profile directory permissions.
- There is no standalone external memory status CLI command in this implementation.

Gateway hygiene:

- Runs only for normal gateway turns, after session ID resolution and before runtime acquisition.
- Skips gateway commands such as `/compact`, `/help`, and `/status`.
- Uses semantic session compression with `trigger: "hygiene"`.
- Creates and adopts a compacted child session when preserved compaction rotates.

Transcript lineage troubleshooting:

- If a gateway session was compacted, inspect the active child session for current work and the parent session for full pre-compaction history.
- Parent sessions ended for semantic compaction should still be searchable; `endedAt` / `endReason` are lifecycle markers, not deletion markers.
- CLI compact commands are intentionally non-rotating in this implementation. Do not expect `parentSessionId` lineage from those surfaces unless a later CLI adoption patch changes them.

## Security Review Checklist

Before merge or release, inspect:

- `AGENTS.md` appears only as project context, not memory.
- `SOUL.md` cannot be compacted or suppressed by learned-memory filtering.
- Session recall is bounded, profile-scoped, and workspace-scoped when a workspace root is supplied.
- Metadata-less legacy sessions are excluded from workspace-scoped recall.
- Recalled, compressed, and external memory is labeled untrusted.
- External memory is disabled by default and cannot write outside profile-local `external-memory/`.
- Mirror writes are opt-in and redact secret-looking payloads.
- External provider audit events are metadata-only and must not include credentials, raw recalled content, or raw mirrored payloads.
- Memory File Compaction creates backups and scans generated content before writes.
- Semantic compression is experimental/default-off and preserves protected head/tail/latest-user/tool-pair context. Tool-result pruning is compression-input-only and must not mutate persisted history.
- Transcript-preserving semantic compaction must create the child transcript before marking the parent ended; audit/event write failures may warn but must not corrupt parent or child transcript state.
- Workflow event summaries remain separate from bare `/compact`.

## Rollout Guidance

Use a conservative rollout:

1. Keep semantic compression disabled until local validation and dogfood are green.
2. Enable manual `/compact` first, then gateway hygiene.
3. Keep external memory disabled unless the file-backed provider is explicitly needed.
4. Review warnings from recall, compaction, compression, and mirror writes before broad use.
5. Run `pnpm run typecheck`, `pnpm run test`, `pnpm run smoke`, and `git diff --check` before merging documentation or runtime changes.
