---
title: "Memory"
description: "Memory system: stores, promotion, rendering, and persistence."
---

# Memory

EstaCoda uses bounded, curated memory files that persist across sessions. The system distinguishes between global shared knowledge, profile user preferences, profile identity, and profile learned facts.

## Files

| File | Lines | Role |
|------|-------|------|
| `src/memory/memory-store.ts` | ~280 | Bounded memory file management |
| `src/memory/local-memory-provider.ts` | ~240 | Read/write memory entries |
| `src/memory/memory-renderer.ts` | ~180 | Render memory into prompt snapshots |
| `src/memory/memory-promotion.ts` | ~260 | Promote repeated preferences and facts |
| `src/memory/memory-tool.ts` | ~140 | Agent-facing memory CRUD tool |

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

## Frozen Snapshot Pattern

Memory content is loaded from disk and rendered into the system prompt as a **frozen snapshot** at session start. The snapshot does not change mid-session. This preserves the LLM's prefix cache.

When the agent adds/removes memory entries during a session, changes are persisted to disk immediately but only appear in the system prompt on the next session start.

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

The agent uses the `memory` tool with these actions:

| Action | Description |
|--------|-------------|
| `add` | Add a new memory entry |
| `replace` | Replace an existing entry via substring matching (`old_text`) |
| `remove` | Remove an entry via substring matching (`old_text`) |

There is no `read` action — memory content is automatically injected into the system prompt.

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

## Limitations

- Memory rendering is selective but not ranked. All entries in budget are included.
- No freshness/staleness handling.
- No provenance links to trajectory events.
- No eval fixtures for memory rendering behavior.
