---
title: Memory architecture
description: Memory files, promotion, retrieval, persistence, and prompt assembly boundaries.
sidebar_position: 5
---

# Memory Architecture

EstaCoda memory is durable runtime context assembled from profile files, shared files, promotion metadata, and optional recall sources. It is not session history, and it is not a hidden policy channel.

This page is for maintainers debugging memory reads, writes, promotion, recall, compaction, or persistence. User-facing behavior is documented in [Memory](../user-guide/memory.md).

---

## Components

| Component | Responsibility |
|---|---|
| `MemoryStore` | In-memory representation of `USER.md`, `MEMORY.md`, `SOUL.md`, and shared memory. Enforces budgets and content scanning. |
| `LocalMemoryProvider` | Runtime provider that writes conclusions to `MemoryStore`, persists files, rolls back failed writes, and exposes search/context. |
| `MemoryPromotionStore` | Loads and writes `promotions.json`; tracks active, superseded, strengthened, and forgotten promotions. |
| `MemoryPersistenceService` | Drift-aware atomic disk writes for memory files and `promotions.json`. |
| `MemoryPromptContextBuilder` | Builds trusted memory blocks and untrusted recall blocks for prompt assembly. |
| `MemoryRecallOrchestrator` | Decides when session or external recall should be added to a turn. |
| `LocalMemoryRetrievalService` | Lexical read/search over authoritative memory files and shared memory. |
| `MemoryFileCompactionService` | Explicit compaction path for `USER.md` and `MEMORY.md`. |
| `AgentLoop` | Calls promotion after a direct user turn and records promotion diagnostics/events. |

Important state paths come from `src/config/profile-home.ts`.

```text
~/.estacoda/
├── sessions.sqlite
├── memory/shared/
└── profiles/<id>/
    ├── USER.md
    ├── SOUL.md
    ├── MEMORY.md
    ├── promotions.json
    ├── external-memory/
    └── temp/
```

---

## Trust Layers

Prompt assembly separates trusted learned memory from untrusted recall.

| Layer | Trust | Notes |
|---|---|---|
| `SHARED.md`, `USER.md`, `MEMORY.md` | Trusted learned memory | Still subordinate to system/developer/repo/current-user instructions. |
| `SOUL.md` | Trusted safety/identity memory | Protected from normal read/search unless explicitly included. |
| Session recall | Untrusted reference context | Added only for recall-style turns. |
| External recall | Untrusted reference context | Provider-backed, bounded, and labeled. |
| Session compression summaries | Untrusted reference context | Not learned memory. |

Retrieved recall must never override security policy, approval state, repo instructions, or current direct user input.

---

## Runtime Promotion Flow

`AgentLoop` calls promotion after a user input event:

```ts
await this.#promoteRepeatedPreferences(input.text, userInputEvent.id);
```

The direct-input boundary matters. `input.text` is the original user text. `effectiveText` may contain resume scaffolding or runtime-expanded text and must not feed promotion.

`#promoteRepeatedPreferences` attempts two independent paths:

1. `resolveUserPreferencePromotion(...)` writes user preferences to `USER.md`.
2. `resolveProjectFactPromotion(...)` writes project facts to `MEMORY.md`.

Preference overflow is non-fatal to the turn and records a best-effort diagnostic. Unexpected promotion errors preserve the existing runtime behavior and remain fatal unless explicitly classified as safe promotion failures. Project-fact promotion remains independent from user-preference promotion.

---

## Candidate Extraction

Promotion starts by extracting typed direct candidates:

```ts
type PromotionStatementCandidate = {
  text: string;
  source: "direct-user-input";
  index: number;
};
```

Extraction is bounded by `MAX_PROMOTION_STATEMENT_CANDIDATES` and currently keeps at most eight candidates.

The extractor:

- strips inline hidden reasoning
- removes fenced code blocks
- splits direct statements on newlines and sentence punctuation
- rejects quoted, backticked, and typographic-quoted spans
- rejects delegated, assistant, tool, resume, and summarize-this scaffolding
- rejects long incidental statements
- rejects invisible and bidirectional control characters

The source remains `direct-user-input`. Do not add assistant, tool, child-session, resume, or delegated-text sources without a new safety design.

---

## Evidence Search

Promotion requires corroborating historical evidence. Both user preferences and project facts call `SessionDB.search(...)` with:

```ts
rootSessionsOnly: true
```

That excludes child sessions from promotion evidence. Existing general search callers still receive child sessions by default unless they explicitly pass `rootSessionsOnly: true`.

Historical matches must be user messages. The detector is rerun on the historical message, and only deterministic key equality counts as evidence.

The current threshold is two matching prior root sessions. The current turn must also contain a supported candidate.

---

## Deterministic Detectors

Promotion logic must remain deterministic. Do not call a model or LLM to decide:

- eligibility
- statement splitting
- canonicalization
- semantic equivalence
- conflict category
- promotion/forget decisions

Supported preference detectors include narrow English and Arabic forms. They canonicalize only where syntax is explicit.

Examples:

| Input | Candidate content |
|---|---|
| `I prefer TypeScript` | `Prefer TypeScript.` |
| `I'd prefer TypeScript` | `Prefer TypeScript.` |
| `My preference is TypeScript` | `Prefer TypeScript.` |
| `We prefer TypeScript` | `Prefer TypeScript.` |
| `Default to TypeScript` | `Prefer TypeScript.` |
| `Use TypeScript by default` | `Prefer TypeScript.` |
| `Please switch to TypeScript by default` | `Prefer TypeScript.` |
| `أفضل TypeScript` | `Prefer TypeScript.` |
| `استخدم pnpm test افتراضياً` | `Prefer pnpm test.` |
| `خلّي الردود مختصرة` | `Prefer concise replies.` |

Near-misses such as `I like TypeScript`, `Maybe use TypeScript`, `Could you use TypeScript`, and `Switch to TypeScript` remain rejected.

Arabic generic `X` captures are intentionally bounded to technical-looking values: known language defaults, package-manager commands, env-style constants, paths, and model/version tokens. This preserves values such as `TypeScript`, `pnpm test`, `~/.estacoda/foo`, and `GPT-5` without accepting broad natural-language phrases.

Project fact detection is separate and narrower. It handles patterns such as `project uses X`, `run tests with X`, and `X is stored under Y`. It does not use preference conflict categories.

---

## Canonicalization and Conflicts

Canonical preferences use stable content and keys. For example:

```text
I prefer TypeScript
Default to TypeScript
Use TypeScript by default
```

all canonicalize to:

```text
Prefer TypeScript.
```

Runtime-derived conflict categories are intentionally exclusive:

| Category | Examples |
|---|---|
| `reply-verbosity` | `Prefer concise replies.`, `Prefer detailed replies.` |
| `language-default` | `Prefer TypeScript.`, `Prefer JavaScript.` |
| `test-command` | `Prefer pnpm test.`, `Prefer npm test.` |
| `package-manager` | `Prefer pnpm.`, `Prefer npm.` |
| `code-style` | `Always use strict mode.`, `Always use semicolons.` |

`MemoryPromotionStore` derives categories from content at comparison time. No category metadata is added to `MemoryPromotionRecord`. Existing records without category fields still load and participate in deterministic conflict handling.

Supersession occurs only when two active user preferences fall into the same intentionally exclusive derived category. Project facts do not use these categories.

---

## Promotion Store Behavior

`promotions.json` has versioned file shape:

```ts
type PromotionFile = {
  version: 1;
  records: MemoryPromotionRecord[];
};
```

`MemoryPromotionStore` normalizes records by content key. It supports:

- creating a new promotion
- strengthening an existing promotion
- replacing a conflicting active preference
- forgetting an active preference
- deactivating a record by id
- restoring records during rollback

For user preferences, the store may mark a conflicting record inactive and set `supersededBy`. For project facts, it only creates or strengthens; it does not run preference conflict handling.

The store flushes records sorted by content. If flush fails, in-memory records roll back to the previous map.

---

## Persistence and Rollback

`MemoryPersistenceService` protects disk writes with two checks:

1. Drift detection compares the current disk snapshot with the loaded snapshot.
2. Atomic write creates a temp file in the target directory and renames it into place.

Snapshots include path, kind, `mtimeMs`, size, and content hash. If another process edited the file after load, `MemoryPersistenceDriftError` is thrown and the file is preserved.

`LocalMemoryProvider` adds higher-level rollback:

- If user-preference markdown persistence fails after metadata changed, restore previous `USER.md` content and previous promotion records.
- If project-fact markdown persistence fails after metadata changed, restore previous `MEMORY.md` content and previous promotion records.
- If a superseding preference fails to persist, restore the superseded record and markdown.
- If scanner rejection occurs after metadata changes, roll back metadata and markdown.

Backups are opt-in through the write policy. Memory file compaction uses backups before applying changes; ordinary promotion writes do not create backups by default.

---

## Safety Scanner

Memory writes pass through scanning in `MemoryStore` and sanitization in `LocalMemoryProvider`.

The path rejects or strips:

- inline hidden reasoning
- prompt-injection-looking content
- credential-looking content
- unsafe compacted output
- budget-overflowing content
- suspicious invisible or bidirectional controls in promotion candidates

Detector syntax can recognize an input before the provider/store rejects it. For example, Arabic syntax can produce `Prefer OPENAI_API_KEY.`, but the safety path rejects it before persistence.

Do not weaken the scanner to make promotion tests pass. Tests should assert rejection and rollback.

---

## Retrieval and Indexing

`LocalMemoryRetrievalService` provides lexical read/search over memory files and shared memory. The index is rebuildable derived state:

```text
~/.estacoda/profiles/<id>/memory-index.sqlite
```

If the index is disabled, missing, or unavailable, read/search may fall back to direct file reads or substring search. `SOUL.md` remains protected and is excluded unless `includeProtected` is explicit.

The index must not become a new authority layer. `USER.md`, `MEMORY.md`, `SOUL.md`, shared memory files, and `promotions.json` remain the authoritative sources.

---

## Compaction and External Memory

`MemoryFileCompactionService` targets `USER.md` and `MEMORY.md` only. It uses the `memory_compaction` auxiliary route, then applies the same scanner and budget checks before writing. Applied compaction creates a timestamped backup and supports restore.

External memory is disabled by default. The file-backed provider stores records under profile-local `external-memory/`. External recall blocks are untrusted reference context. External provider failures must not corrupt or replace local memory.

---

## Test Surfaces

Focused checks:

```bash
pnpm exec vitest run src/memory/memory-promotion.test.ts
pnpm exec vitest run src/memory/memory-hardening-evals.test.ts
pnpm exec vitest run src/runtime/agent-loop.test.ts
pnpm exec vitest run src/session/sqlite-session-db.test.ts src/session/in-memory-session-db.test.ts
pnpm exec vitest run src/memory/memory-persistence-service.test.ts
pnpm exec vitest run src/memory/local-memory-provider.test.ts
pnpm exec vitest run src/memory/memory-store.test.ts
pnpm exec vitest run src/memory/memory-prompt-context-builder.test.ts
pnpm exec vitest run src/memory/memory-retrieval-service.test.ts
pnpm exec vitest run src/memory/memory-file-compaction-service.test.ts
```

When debugging promotion, inspect in this order:

1. Current direct `input.text`.
2. Extracted direct candidates.
3. Session search query and `rootSessionsOnly` behavior.
4. Historical root-session user messages.
5. Canonical key equality.
6. `promotions.json`.
7. Markdown file write and rollback behavior.

Treat any LLM/model call in promotion eligibility, equivalence, conflict, or category logic as a regression.

---

## Related

- [Memory](../user-guide/memory.md) - user-facing memory guide
- [Runtime](./runtime.md) - runtime creation and session boundaries
- [Provider runtime](./provider-runtime.md) - provider execution boundaries
- [State and Files](../reference/state-and-files.md) - profile and global state paths
