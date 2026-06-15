---
title: Memory architecture
description: Memory files, recall, indexing, compaction, and prompt assembly boundaries.
sidebar_position: 5
---

# Memory architecture

EstaCoda memory is a bounded set of durable profile and shared context that can be assembled into prompts. It is not the session history database, and it is not a hidden policy channel. Memory is loaded into the runtime, filtered, budgeted, labeled by trust, and then passed to prompt assembly.

This page is for maintainers and operators debugging memory writes, recall, indexing, compaction, or prompt context. User-facing behavior lives in [Memory](../user-guide/memory.md).

---

## What this page covers

Use this page when you need to inspect:

- where memory files live
- which memory files are budgeted
- why a memory write was rejected
- how memory reaches the prompt
- when session or external recall is included
- why search did or did not return protected memory
- how memory indexing, fallback retrieval, compaction, and promotions work

Memory affects future behavior. Treat it as durable execution context and keep it reviewable.

---

## Memory layers

EstaCoda has four memory-related context layers:

| Layer | Scope | Purpose |
|---|---|
| Profile memory files | Profile | Durable user, project, and identity context for one profile. |
| Shared memory | Global | Cross-profile shared context under the EstaCoda home directory. |
| Session recall | Session database | Historical session excerpts retrieved for explicit recall-style turns. |
| External recall | Configured providers | Reference context from configured external memory providers. |

Profile memory and shared memory are loaded into `MemoryStore` and treated as trusted prompt context after filtering. Session recall and external recall are reference context. They are labeled untrusted and must not override canonical instructions or safety policy.

---

## State paths

Profile memory files live under:

```text
~/.estacoda/profiles/<id>/
```

Important profile files:

| File | Purpose |
|---|---|
| `USER.md` | Learned facts about the operator, preferences, habits, and corrections. |
| `MEMORY.md` | Learned project/workflow facts and conventions. |
| `SOUL.md` | Identity and safety guidance. |
| `promotions.json` | Promotion metadata for learned memory facts. |
| `memory-index.sqlite` | Profile memory search index, when enabled. |
| `external-memory/` | Profile-local storage for the file-backed external memory provider. |

Shared memory is global:

```text
~/.estacoda/memory/shared/
```

Shared memory is loaded into the logical memory kind `SHARED.md`. It is not a profile-local `SHARED.md` file.

---

## Memory files and budgets

The runtime memory kinds are:

| Kind | Default budget | Prompt role |
|---|---:|---|
| `USER.md` | 1,375 characters | Learned user context. |
| `MEMORY.md` | 2,200 characters | Learned project/workflow context. |
| `SOUL.md` | No default budget | Identity and safety context. |
| `SHARED.md` | No default budget | Shared global context loaded from `~/.estacoda/memory/shared/`. |

Budgets are character limits, not token limits. `MemoryStore` enforces them at write time. If a write exceeds a configured budget, `MemoryBudgetOverflowError` is thrown and the previous memory content is preserved.

Memory files are loaded when the runtime is created. Edits made outside the running runtime, such as changing `USER.md` in an editor, are picked up by a fresh runtime or session reset rather than being re-read from disk on every turn.

---

## Memory operations

The structured memory operation types are:

| Operation | Behavior |
|---|---|
| `append` | Adds content to the end of a memory file. Duplicate content is rejected. |
| `replace` | Replaces one unique match with replacement content. |
| `remove` | Removes one unique match. |

All operations pass through `MemoryStore`. The store enforces:

- memory content scanning
- character budgets
- duplicate append protection
- unique-match requirements for replace and remove

Memory writes should never be used to store secrets, raw provider reasoning, raw tool results, approval tokens, or one-off transient context.

---

## Prompt assembly

`MemoryPromptContextBuilder` builds the memory context used by prompt assembly.

It produces:

| Block group | Contents | Trust |
|---|---|---|
| `frozenCompactMemory` | `SHARED.md`, filtered `USER.md`, filtered `MEMORY.md` | Trusted |
| `safetyMemory` | `SOUL.md` | Trusted |
| `sessionRecall` | Session recall blocks, when included | Untrusted |
| `externalRecall` | External provider recall blocks, when included | Untrusted |

The builder also records `MemoryPromptDiagnostics`, including included blocks, suppressed entries, duplicate entries removed, recall decisions, budget pressure, compaction pressure, and warnings.

Inactive promoted memory entries are filtered before prompt assembly. Duplicate learned-memory lines are deduplicated in the prompt context.

---

## Recall orchestration

`MemoryRecallOrchestrator` decides whether to add recall blocks for a turn.

Session recall uses `SessionRecallService`. It is triggered by explicit recall-style user intent, such as asking what happened in a previous session or asking to find prior work. If no trigger is detected, session recall is not included.

External recall uses configured `ExternalMemoryProvider` instances. It is included only when:

- external memory is enabled
- at least one provider is configured
- the turn matches the same explicit recall path

External recall blocks are prefixed and labeled as untrusted historical context. They can help retrieval, but they must not override profile memory, repo instructions, safety policy, or operator approvals.

---

## External memory

The built-in external memory provider is file-backed. It stores records under the profile's `external-memory/` directory and constrains configured paths to stay under that directory.

External memory can mirror memory writes when configured. Mirroring is best-effort: local memory remains the canonical write path, and external provider failures must not block successful local memory writes.

External provider status output is redacted. Do not expose provider secrets, raw records, or private paths in diagnostics.

---

## Indexing and retrieval

`LocalMemoryRetrievalService` provides lexical retrieval over memory files and shared memory. The index path is profile-local:

```text
~/.estacoda/profiles/<id>/memory-index.sqlite
```

Defaults:

| Config | Default | Behavior |
|---|---|---|
| `memory.retrieval.enabled` | `true` | Enables local memory retrieval. |
| `memory.retrieval.mode` | `lexical` | Uses lexical retrieval. |
| `memory.retrieval.maxResults` | `10` | Caps returned results. |
| `memory.retrieval.maxChars` | `4,000` | Caps returned characters. |
| `memory.index.enabled` | `true` | Enables the SQLite-backed index. |
| `memory.index.backfillOnStartup` | `bounded` | Backfills index entries on startup. |
| `memory.index.reindexOnStartup` | `false` | Does not rebuild the full index by default. |
| `memory.index.vacuumIntervalDays` | `7` | Runs periodic index maintenance. |

If the index is disabled, unavailable, or empty, retrieval can fall back to direct memory file reads and substring search. Fallback is less capable than indexed retrieval, but memory access should degrade instead of disappearing.

`SOUL.md` is protected identity memory. It is excluded from general search by default and included only when `includeProtected` is explicitly set.

---

## Compaction

`MemoryFileCompactionService` can compact `USER.md` and `MEMORY.md` through the provider-backed `memory_compaction` auxiliary route.

The service is conservative:

- it targets budgeted learned-memory files
- it writes a backup before applying changes
- it runs output through the memory content scanner
- it rejects output that still exceeds the target budget
- it supports dry-run and restore paths

Compaction is an explicit service/tool path unless profile configuration enables stronger automation around it. Do not treat compaction output as trusted just because a model produced it; it must pass the same memory safety and budget checks.

---

## Promotions

`MemoryPromotionStore` tracks promoted memory facts in:

```text
~/.estacoda/profiles/<id>/promotions.json
```

Promotions carry metadata such as occurrence counts, confidence, state, and source session IDs. Inactive promotions are suppressed before prompt assembly.

Promotions are metadata about learned facts. They are not a separate authority layer that can override `SOUL.md`, repo instructions, security policy, or approval decisions.

---

## Inspection and tests

Useful files:

- `src/contracts/memory.ts`
- `src/config/memory-config.ts`
- `src/config/profile-home.ts`
- `src/runtime/create-runtime.ts`
- `src/memory/memory-store.ts`
- `src/memory/local-memory-provider.ts`
- `src/memory/memory-prompt-context-builder.ts`
- `src/memory/memory-recall-orchestrator.ts`
- `src/memory/memory-retrieval-service.ts`
- `src/memory/memory-index.ts`
- `src/memory/memory-index-sync.ts`
- `src/memory/memory-file-compaction-service.ts`
- `src/memory/memory-promotion-store.ts`
- `src/memory/external-memory-provider.ts`
- `src/prompt/prompt-assembly.ts`

Focused checks:

```bash
pnpm exec vitest run src/memory/memory-store.test.ts
pnpm exec vitest run src/memory/local-memory-provider.test.ts
pnpm exec vitest run src/memory/memory-prompt-context-builder.test.ts
pnpm exec vitest run src/memory/memory-recall-orchestrator.test.ts
pnpm exec vitest run src/memory/memory-retrieval-service.test.ts
pnpm exec vitest run src/memory/memory-index.test.ts
pnpm exec vitest run src/memory/memory-index-sync.test.ts
pnpm exec vitest run src/memory/memory-file-compaction-service.test.ts
pnpm exec vitest run src/memory/memory-tool.test.ts
pnpm exec vitest run src/memory/memory-hardening-evals.test.ts
```

When debugging memory, first inspect the profile memory files and `promotions.json`, then inspect prompt diagnostics and recall decisions. If untrusted recall appears to override canonical memory, treat that as a bug.

---

## Related

- [Architecture](./architecture.md) - system structure and state boundaries
- [Runtime](./runtime.md) - runtime creation and session boundaries
- [Provider runtime](./provider-runtime.md) - provider execution and replay boundaries
- [Memory](../user-guide/memory.md) - user-facing memory guide
- [State and Files](../reference/state-and-files.md) - profile and global state paths
