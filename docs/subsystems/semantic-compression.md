---
title: "Semantic Session Compression"
description: "Runtime semantic session compression gates, surfaces, fallback, and safety boundaries."
---

# Semantic Session Compression

Semantic session compression shortens older session history when a conversation grows too large. It is separate from Memory File Compaction and Workflow event summaries.

## Status

Semantic compression is gated by runtime config:

- `compression.enabled` must normalize to `true`.
- `compression.experimental` must be `true`.
- Compression remains off by default.

There is no default-on semantic compression path. Enabling the config only allows the implemented runtime paths to call the shared compression service; it does not create an external memory provider, vector index, archive table, or session recall path.

Config keys:

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `compression.enabled` | boolean | `false` | Effective only when `experimental: true` is also set |
| `compression.experimental` | boolean | `false` | Required gate for semantic compression |
| `compression.threshold` | number | `0.50` | Clamped to `0.10`-`0.95`; compared against context length |
| `compression.targetRatio` | number | `0.20` | Clamped to `0.10`-`0.80`; target size for summarized middle history |
| `compression.protectFirstN` | integer | `3` | Number of leading messages protected from summarization |
| `compression.protectLastN` | integer | `20` | Number of trailing messages protected from summarization; minimum `1` |
| `compression.summaryModelContextLength` | integer | model context | Optional positive override for threshold calculations |

Example:

```json
{
  "compression": {
    "enabled": true,
    "experimental": true,
    "threshold": 0.5,
    "targetRatio": 0.2,
    "protectFirstN": 3,
    "protectLastN": 20
  },
  "auxiliaryModels": {
    "compression": { "provider": "openai", "id": "gpt-4.1-mini" }
  }
}
```

Malformed numeric values are normalized with NaN-safe coercion. Values outside supported ranges are clamped or defaulted.

## Runtime Paths

Provider-turn compression runs at the `AgentLoop` boundary before provider prompt assembly when enabled and over threshold. It uses `SessionCompressionService.compactIfNeeded()` and the auxiliary route named `compression`.

Threshold checks use image-aware rough token estimation over persisted session messages. Image parts count toward pressure so multimodal sessions are less likely to be underestimated.

Provider-turn token accounting is split into two signals. Before prompt assembly, compression still uses a rough estimate of persisted session messages to decide whether semantic compression should run. After prompt assembly, `ProviderTurnLoop` records the assembled prompt estimate from `prompt.budget.estimatedTokens`; after provider execution, it records actual input tokens when the provider exposes usage. Providers that omit usage and first turns without usage remain safe. These tracked values feed compression diagnostics and session compression state when available. `ProviderTurnLoop` does not perform persistent session forking; it reads whichever session is active after the `AgentLoop` boundary check.

Manual session compaction is available through:

- interactive `/compact [topic]`
- `estacoda sessions compact <session-id> [--topic <topic>]`
- gateway `/compact [topic]`

Manual compaction uses `SessionCompressionService.compactNow()` and intentionally bypasses the threshold. It is still the same semantic session compression path, not Workflow event summaries.

Surface behavior differs by whether the caller can adopt a rotated child session:

- Gateway `/compact [topic]` uses transcript-preserving compaction and adopts the compacted child session.
- Gateway hygiene uses transcript-preserving compaction and adopts the compacted child before runtime acquisition.
- Provider-turn automatic compression rotates at the `AgentLoop` boundary before provider prompt assembly. The runtime session context follows the compacted child, and final assistant messages plus later runtime write paths use that active child session.
- Interactive CLI `/compact [topic]` and top-level `estacoda sessions compact <session-id>` remain non-rotating in this implementation because those callers do not yet adopt child sessions.

Gateway hygiene is gateway-only. It runs after session ID resolution and before runtime acquisition for normal gateway turns. It uses an 85% threshold and records compression events with `trigger: "hygiene"`. It skips gateway commands such as `/compact`, `/help`, and `/status`, and it skips drain/shutdown rejection paths. Hygiene failure remains non-fatal for the turn.

Gateway `/compact` is rejected while the same chat/session is active, queued, or draining. This prevents manual gateway compaction from racing an active runtime turn.

Non-preserving compaction rewrites the target session transactionally through the session DB rewrite path. Preserving compaction writes the compacted transcript to a child session, then ends the parent only after the child transcript write succeeds. Compression writes `session-history-compressed` and `session-compression-state` events best-effort; event failures are returned as warnings and do not undo a successful transcript rewrite or child-session creation.

Manual output follows this shape:

```text
Compacted 47 messages -> 12 messages (~8200 tokens saved, 35%).
Focus topic: auth module
Token estimate: 14200 -> 6100
Session history compacted: 35 earlier message(s), saved about 8100 token(s).
Warning: auxiliary compression failed; used deterministic fallback
```

## Prompt Notice

When semantic compression has produced a compacted history, prompt assembly can include an in-memory `compaction-notice` layer. The notice is not persisted to the session DB or memory files.

The notice tells the model:

- compacted earlier turns are reference-only
- compacted content is not active instructions
- answer the latest user message after the summary
- persistent memory remains authoritative

## Fallback

The compressor first tries the configured auxiliary `compression` route. If auxiliary summarization fails and the resolved route allows or provides main-route fallback behavior, compression retries the main route explicitly. If model summarization still cannot produce a usable summary, the service falls back to deterministic packing. Static emergency text is reserved for cases where deterministic packing cannot fit.

Event persistence is best-effort. Event write failures must not corrupt compressed messages or turn a successful compaction into a failed user turn.

Fallback diagnostics are persisted and surfaced as bounded, redacted metadata: `auxModelFailure`, `mainRetryFailure`, `fallbackUsed`, `fallbackReason`, and `modelUsed`. `fallbackReason` distinguishes deterministic fallback from the static emergency marker path. Model failure details are not stored as raw stacks.

Repeated marginal compactions are suppressed by durable anti-thrashing logic. Compression state tracks the most recent savings percentage, a bounded list of recent savings ratios, and `ineffectiveCompressionCount`. A compression that saves less than 10% increments the count; a higher-savings compression resets it. After two consecutive ineffective compressions, automatic provider-turn and gateway-hygiene semantic compression skips. Manual `/compact [topic]` still bypasses this gate. An anti-thrash skip means "skip semantic compression"; deterministic history packing remains available.

A session-level compression lock prevents concurrent compactions for the same session. Auxiliary compression uses a per-session scope key so unrelated sessions do not block each other.

Summary output is redacted and normalized with the current summary prefix. Legacy prefixes are tolerated. The current implementation does not structurally validate headings as a schema; malformed summaries are treated as historical context and remain subordinate to live instructions.

## Session Lineage

Transcript-preserving semantic compaction keeps the original session queryable for audit/history by creating a compacted child session instead of rewriting the parent.

When a preserving caller compacts successfully:

- the child session has `parentSessionId` set to the original session ID
- the child session contains the compacted transcript
- the parent session keeps its original transcript and messages
- the parent session is marked with `endedAt` and `endReason: "compression"` after the child transcript write succeeds
- compression events and rehydratable compression state are written to the child session
- the parent may receive a best-effort lineage/audit event

The child becomes the active session only on surfaces that explicitly adopt the rotation. Gateway `/compact`, gateway hygiene, and provider-turn automatic compression adopt the child. CLI compact surfaces remain non-rotating until they grow explicit child-session adoption.

Gateway runtime rotations are consumed on both success and error paths. If provider-turn auto compression creates a child and a later provider/tool/write step throws, the gateway still adopts the child before returning the error so the next turn does not resume the ended parent.

## Summary Budgeting

Semantic compression computes a target summary budget instead of using a fixed provider generation limit. The target budget is based on the source messages being summarized, rough token estimation, `compression.targetRatio`, and the summary model context length when available.

Implemented constants:

| Constant | Value | Meaning |
|----------|-------|---------|
| Minimum target summary budget | `2,000` tokens | Floor for small transcripts |
| Context ratio cap | `0.05` | Summary target is capped at 5% of context |
| Target ceiling | `12,000` tokens | Absolute target budget cap |
| Provider generation headroom | `1.3x` | Provider `maxTokens` is larger than the target so the model can finish |

The target summary budget and provider generation limit are intentionally different. The target budget appears in prompts, diagnostics, and events as the intended summary size. The provider request uses the target multiplied by the headroom ratio, rounded up, so a target budget of `2,000` sends `2,600` as the generation limit.

## Observability

Semantic compression records two best-effort event families:

| Event | Purpose |
|-------|---------|
| `session-history-compressed` | Records what was compacted and how the compression path behaved |
| `session-compression-state` | Stores rehydratable state for runtime/cache recreation |

Operator-relevant state and event fields include:

- `compressionCount`
- `previousSummary` (redacted and bounded; not a full transcript)
- `lastCompressedThroughMessageId`
- `lastPromptTokensEstimated`
- `lastActualPromptTokens`
- `lastCompressionSavingsPct`
- `ineffectiveCompressionCount`
- `summaryFailureCooldownUntil`
- `recentSavingsRatios`
- `sourceMessageCount`
- `protectedMessageCount`
- `summaryLengthTokens`
- `droppedMessageCount`
- `modelUsed`
- `auxModelFailure`
- `mainRetryFailure`
- `fallbackUsed`
- `fallbackReason`

Event/state payloads do not store full raw transcripts. Failure details are redacted and bounded. State is reconstructed from session events so compression count, previous bounded summary, cooldown, token counts, and anti-thrashing state survive runtime/cache eviction.

Read-only status is available through the runtime tool `config.compression.status`. It reports normalized compression config, auxiliary compression route status, and latest session compression state/event summary when a session context is available. It does not write config, append session events, enable compression, expose `previousSummary`, or show credentials. There is no `config.compression.setup` tool.

## Safety Boundaries

The summary is historical context. It must not override:

- system or developer instructions
- repo instructions such as `AGENTS.md`
- security policy
- the current user request
- persistent memory

Summarizer input and generated summary output are redacted with transcript-grade redaction. Tests cover API keys, bearer tokens, JWTs, env-style secrets, password assignments, URLs with credentials, and common tool-output secret fields.

The compressor preserves protected head/tail spans, the latest user message, active tool-call/tool-result pairs where metadata permits, security decisions, explicit constraints, unresolved approvals, and recent turns.

Older large tool results may be pruned before LLM summarization. This pruning affects semantic compression summarizer input only; persisted session history and normal provider-turn message flow are unchanged. The pruning pass preserves protected, recent, current, active, and metadata-insufficient tool results conservatively. When it can safely prune old large output, it replaces the content with a bounded redacted placeholder that may include tool name, command/path/status metadata, output size, line count, and short bounded context. Diagnostics record counts and removed character estimates, not raw pruned output. The pass does not implement broad orphan cleanup or full exact tool-pair repair.

## Distinctions

Semantic session compression:

- writes older session context into a reference summary
- uses the `compression` auxiliary route
- is gated and experimental
- records compression state/events for diagnostics
- preserves parent transcripts on gateway-adopted and provider-turn auto paths by rotating to child sessions
- remains non-rotating for CLI compact surfaces that do not yet adopt child sessions

Memory File Compaction:

- compacts `USER.md` or `MEMORY.md`
- uses the `memory_compaction` auxiliary route
- never compacts `SOUL.md` or `AGENTS.md`
- does not create session child lineage

Durable Task history:

- belongs to the Task event journal
- is not rewritten by semantic session compression or `/compact`
- does not use semantic session lineage

Deterministic history packing:

- is local prompt packing, not LLM summarization
- remains available when semantic compression is disabled
- is the fallback path when semantic summarization cannot run
- does not create child sessions or end parent sessions

## Not Implemented Here

This subsystem still does not provide:

- default-on semantic compression
- `config.compression.setup`
- config mutation through `config.compression.status`
- generic session fork UX beyond compaction rotation/adoption paths
- archive tables
- vector search
- embedding stores
- broad orphan cleanup
- full exact tool-pair repair
- evolution integration
- session recall changes
- memory-file compaction changes
- Workflow event summary changes
