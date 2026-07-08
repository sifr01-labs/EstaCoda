---
title: Memory
description: How EstaCoda stores, promotes, inspects, and repairs durable memory.
sidebar_position: 7
---

# Memory

EstaCoda memory is durable context stored in files. It helps future sessions remember durable preferences, project facts, operating style, recurring constraints, and operator-curated notes.

Memory is not a hidden authority layer. System instructions, developer instructions, repo instructions, `AGENTS.md`, security policy, and the current user request still win.

Use this page to understand what can be remembered, where it is stored, how curation and promotion work, and how to inspect or repair it.

---

## What Memory Is

EstaCoda has several related stores. They are not interchangeable.

| Store | Where it lives | What it is for |
|---|---|---|
| Session history | Session database | Past turns and events. Used for transcripts, recall, curation checkpoints, and promotion evidence. |
| Profile memory | `~/.estacoda/profiles/<id>/USER.md`, `MEMORY.md`, `SOUL.md` | Durable context for one profile. |
| Project/workspace memory | Usually `MEMORY.md` plus repo context such as `AGENTS.md` | Project facts, conventions, and workflow notes. |
| Shared memory | `~/.estacoda/memory/shared/` | Global snippets available across profiles. |
| Promotion metadata | `~/.estacoda/profiles/<id>/promotions.json` | Tracks promoted facts, active/inactive state, source sessions, and confidence. |
| Curation history | `~/.estacoda/profiles/<id>/memory-curation.json` | Tracks memory curation checkpoints, triggers, outcomes, and hashed operation metadata. |

`AGENTS.md` is not memory. It is workspace instruction context. It is not promoted, compacted, or edited by memory tools.

---

## What Memory Is Not

Memory does not:

- save every interesting sentence
- promote assistant output, tool output, child-session output, resumes, or delegated text
- let recalled history override security policy or the current user request
- store secrets or prompt-injection-looking text
- let the extraction model enforce write policy
- automatically trust old session content as an instruction

Session recall and external recall are reference context. They are labeled as untrusted historical context. Curated memory files are stronger than recall, but still below current instructions and safety policy.

---

## Profile Files

Profile-local memory lives under:

```text
~/.estacoda/profiles/<id>/
```

Important files:

| File | Purpose | Default budget |
|---|---|---:|
| `USER.md` | User preferences and communication style | 1,375 characters |
| `MEMORY.md` | Project, workflow, and durable operational facts | 2,200 characters |
| `SOUL.md` | Identity and safety guidance | Configurable |
| `promotions.json` | Promotion metadata | No markdown budget |

Shared memory lives under:

```text
~/.estacoda/memory/shared/
```

Prompt render order is:

```text
memory/shared/ -> USER.md -> SOUL.md -> MEMORY.md
```

---

## How Curation Works

Memory curation is the proactive memory path. It reviews recent transcript slices at natural checkpoints, asks an auxiliary model to extract structured durable facts with evidence, then applies deterministic policy in the runtime.

The model extracts facts. The runtime decides what happens to them.

Each extracted fact includes:

| Field | Meaning |
|---|---|
| `statement` | The durable fact in plain language. |
| `evidence` | Exact spans from source messages. |
| `category` | Work, project, preference, operating style, recurring constraint, technical default, personal, or other. |
| `explicitness` | `explicit`, `strongly-implied`, or `inferred`. |
| `sensitivity` | `none`, `private`, `sensitive`, or `secret`. |
| `confidence` | A normalized score used by runtime policy. |

Default mode is `auto`. Auto mode is still conservative: it auto-applies only explicit, non-sensitive, low-risk facts that pass evidence, duplicate, scanner, budget, and confidence gates. The default confidence gate is `0.7`.

Other modes:

| Mode | Behavior |
|---|---|
| `auto` | Auto-apply low-risk eligible facts; queue or ignore the rest. |
| `review` | Record pending-review curation records without writing memory. |
| `manual` | Skip background checkpoints; explicit manual curation commands still work. |

Curation runs at configured natural checkpoints:

- every `memory.curation.checkpointEveryTurns` completed root-session turns
- `/compact` and session compaction when enabled
- `/handoff` when enabled
- runtime dispose when enabled and minimum message/interval gates pass
- explicit `memory populate` or `/memory populate`

When curation writes memory, it targets `USER.md` or `MEMORY.md`. It does not write `SOUL.md`, shared memory, `AGENTS.md`, or session history. Auto-writes are recorded in curation history and runtime/session events; they are visible without interrupting every turn.

Shared controls are available from the top-level CLI, in-session slash commands, and authorized gateway surfaces such as Telegram:

```bash
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

Inside a session or Telegram chat, use the same subcommands through `/memory`:

```text
/memory mode review
/memory populate
/memory recent
/memory review
/memory apply <record-id> [candidate-id|all]
/memory reject <record-id> [candidate-id|all]
/memory undo <record-id>
/memory forget <USER.md|MEMORY.md> <exact text>
/memory edit
/memory clear [USER.md|MEMORY.md|all] --yes
```

`memory review` shows pending-review records and low-risk stored candidate operations. Use `memory apply` or `memory reject` to resolve them, `memory undo` to reverse an applied curation record, and `memory forget` to remove exact text from `USER.md` or `MEMORY.md`.

---

## How Promotion Works

Promotion is deterministic. It runs after a turn and looks only at direct user input from the current turn plus matching historical root-session evidence.

Promotion can create:

| Promoted content | Destination |
|---|---|
| Repeated user preferences | `USER.md` |
| Repeated project facts | `MEMORY.md` |

The runtime passes the original `input.text` to promotion. Resume-expanded text and runtime scaffolding are not promotion input.

Promotion requires:

1. The current direct user input contains a supported promotion candidate.
2. At least two matching prior root sessions contain the same deterministic candidate.
3. The matching historical messages are user messages.
4. The content passes memory safety scanning and file budget checks.

Child sessions are excluded from promotion evidence. Delegated work can be useful context, but it cannot teach durable user preferences by itself.

---

## What Can Promote

Supported user preference patterns are intentionally narrow.

English examples:

| Input | Promoted memory |
|---|---|
| `I prefer TypeScript` | `Prefer TypeScript.` |
| `I'd prefer TypeScript` | `Prefer TypeScript.` |
| `My preference is TypeScript` | `Prefer TypeScript.` |
| `We prefer TypeScript` | `Prefer TypeScript.` |
| `Default to TypeScript` | `Prefer TypeScript.` |
| `Use TypeScript by default` | `Prefer TypeScript.` |
| `Please switch to TypeScript by default` | `Prefer TypeScript.` |
| `I prefer concise replies` | `Prefer concise replies.` |

Arabic examples:

| Input | Promoted memory |
|---|---|
| `أفضل TypeScript` | `Prefer TypeScript.` |
| `أفضّل TypeScript` | `Prefer TypeScript.` |
| `افضل TypeScript` | `Prefer TypeScript.` |
| `استخدم pnpm افتراضياً` | `Prefer pnpm.` |
| `استخدم pnpm افتراضيا` | `Prefer pnpm.` |
| `استخدم pnpm كافتراضي` | `Prefer pnpm.` |
| `خلّي الردود مختصرة` | `Prefer concise replies.` |
| `خلي الردود مختصرة` | `Prefer concise replies.` |
| `خلّي الردود مفصلة` | `Prefer detailed replies.` |
| `خلي الردود مفصلة` | `Prefer detailed replies.` |

Arabic mixed-language preference values are accepted only for bounded technical tokens, such as:

- `TypeScript`
- `pnpm test`
- `~/.estacoda/foo`
- `GPT-5`

This preserves exact casing, spacing, paths, and provider/model tokens where supported. Natural-language Arabic or mixed-language phrases such as `أفضل لغة آمنة` or `استخدم careful release notes كافتراضي` do not promote.

Project fact promotion remains separate from user preferences. Examples include:

| Input | Promoted memory |
|---|---|
| `project uses TypeScript` | `Project uses TypeScript.` |
| `run tests with pnpm test` | <code>Run tests with `pnpm test`.</code> |
| `foo is stored under ~/.estacoda/foo` | <code>Foo is stored under `~/.estacoda/foo`.</code> |

---

## What Cannot Promote

These inputs are rejected as promotion evidence:

- quoted or backticked text
- fenced code blocks
- long incidental paragraphs
- assistant notes
- tool output
- resume text
- delegated or child-session text
- prompt-injection-looking text
- secret-looking content
- text containing invisible or bidirectional control characters

Examples that do not promote:

```text
Please summarize this: "I prefer concise replies."
The attached resume says: "I prefer concise replies."
Agent note: I prefer concise replies.
Earlier assistant said: "User prefers concise replies."
لخّص هذا: "أفضل TypeScript"
لخّص هذا: «أفضل TypeScript»
ملاحظة الوكيل: أفضل TypeScript
السيرة تقول: أفضل TypeScript
قال المساعد سابقاً: المستخدم يفضل TypeScript
```

Near-miss English phrases also do not promote:

```text
I like TypeScript
It would be nice if TypeScript
Maybe use TypeScript
Could you use TypeScript
Can we use TypeScript
For this one, use TypeScript
Try TypeScript
Switch to TypeScript
```

---

## Conflicts and Forgetting

Some preference categories are intentionally exclusive:

| Category | Examples |
|---|---|
| Reply verbosity | `Prefer concise replies.`, `Prefer detailed replies.` |
| Language default | `Prefer TypeScript.`, `Prefer JavaScript.` |
| Test command | `Prefer pnpm test.`, `Prefer npm test.` |
| Package manager | `Prefer pnpm.`, `Prefer npm.` |
| Code style | `Always use strict mode.`, `Always use semicolons.` |

When a new active preference in one of these categories promotes, it supersedes the old active preference in that category. Unrelated preferences coexist. `Prefer TypeScript.` does not conflict with `Prefer careful release notes.`.

Conflict categories are derived at runtime from canonical content. They are not stored as schema fields in `promotions.json`, so existing promotion records still load and participate in conflict handling.

To forget a promoted preference, say a direct forget request such as:

```text
forget that i prefer concise replies
```

If the active promoted preference exists, EstaCoda marks it forgotten in `promotions.json` and removes the corresponding line from `USER.md`.

---

## Write Safety

Memory writes pass through safety checks before persistence.

The write path rejects:

- credential-looking content, including env var names such as `OPENAI_API_KEY` when they would become durable memory
- prompt-injection-looking content
- unsafe compacted memory output
- content that exceeds the target memory file budget

Arabic input such as `استخدم OPENAI_API_KEY كافتراضي` can match the deterministic syntax, but the provider/store safety path rejects it before persistence.

Memory writes use atomic replacement. EstaCoda writes a temporary file in the target directory and renames it into place. If a write fails, the previous file remains.

Memory persistence is also drift-aware. Before overwriting a file, the persistence service compares the current disk file with the snapshot loaded earlier. If another process edited the file, EstaCoda refuses to overwrite it by default.

Promotion writes roll back both markdown and `promotions.json` when a later step fails. This prevents stale active metadata from surviving a rejected markdown write.

Backups are not created for ordinary writes by default. They are created only by operations that explicitly request them, such as applied memory file compaction.

---

## Inspect Memory

Use curation history when you want to understand what the agent recently remembered or queued:

```bash
estacoda memory recent
estacoda memory review
estacoda memory mode
```

Use CLI read/search when you want the current authoritative memory content:

```bash
estacoda memory read USER.md
estacoda memory read MEMORY.md
estacoda memory search <query>
estacoda memory read shared <key>
```

`SOUL.md` is protected. Read it only with an explicit protected-memory flag:

```bash
estacoda memory read SOUL.md --include-protected
```

Inspect the files directly when you need to repair state:

```bash
ls ~/.estacoda/profiles/<id>/
sed -n '1,160p' ~/.estacoda/profiles/<id>/USER.md
sed -n '1,160p' ~/.estacoda/profiles/<id>/MEMORY.md
sed -n '1,160p' ~/.estacoda/profiles/<id>/promotions.json
```

Do not edit `promotions.json` casually. It tracks active, superseded, and forgotten promotions. If it disagrees with the markdown files, rendering may suppress or restore entries in surprising ways.

---

## Edit Memory Safely

Memory files are plain Markdown. Use the memory edit helper or stop the runtime before manual edits when possible:

```bash
estacoda memory edit
$EDITOR ~/.estacoda/profiles/<id>/USER.md
$EDITOR ~/.estacoda/profiles/<id>/MEMORY.md
```

Use one line per durable fact or preference. Keep entries short and reviewable.

Back up files before larger edits:

```bash
cp ~/.estacoda/profiles/<id>/USER.md ~/.estacoda/profiles/<id>/USER.md.bak
cp ~/.estacoda/profiles/<id>/MEMORY.md ~/.estacoda/profiles/<id>/MEMORY.md.bak
```

If you remove a promoted line manually, inspect `promotions.json` as well. Prefer the explicit forget path for user preferences so metadata and markdown stay aligned.

To clear learned profile memory through the guarded command path:

```bash
estacoda memory clear USER.md --yes
estacoda memory clear MEMORY.md --yes
estacoda memory clear all --yes
```

`memory clear` never clears `SOUL.md` or shared memory. Existing live sessions may need `/new` or restart to reload prompt memory after manual edits or clears.

---

## Local Lexical Retrieval

Local memory read/search is deterministic lexical retrieval over authoritative memory files. It is not semantic recall or vector search.

The rebuildable index is stored under profile state:

```text
<profile-state-dir>/memory-index.sqlite
```

Deleting this SQLite file does not delete `USER.md`, `SOUL.md`, `MEMORY.md`, shared memory files, or `promotions.json`.

Repair the index with:

```bash
estacoda memory index path
estacoda memory index status
estacoda memory index rebuild
```

If the index is disabled, missing, or unavailable, `memory.read`, `memory.search`, and CLI read/search fall back to bounded direct file reads or substring search where possible.

---

## Delegation Outcome Telemetry

Delegation outcomes are separate from child transcript recall and canonical prompt memory. They are recorded as operational telemetry in session events and trajectory records.

Recorded outcome telemetry can include bounded status metadata such as parent session id, child session id, role, depth, task index, status, reason, timestamp, token usage, and a bounded task preview.

It does not write to `MEMORY.md`, and it does not store raw child output, prompts, transcripts, tool arguments, file contents, diagnostic payloads, or credentials in canonical memory. Child transcripts remain excluded from promotion evidence.

---

## Session Compression and Memory Compaction

Session compression and memory file compaction are different operations.

| Operation | What it changes |
|---|---|
| Session compression | Older session history. Produces untrusted historical summaries. |
| Memory file compaction | `USER.md` or `MEMORY.md`. Produces replacement memory file content after checks. |

Memory file compaction uses the `memory_compaction` auxiliary route, supports `dryRun`, and creates a timestamped backup before applying changes. It does not compact `SOUL.md`, `AGENTS.md`, shared memory, session history, or `promotions.json`.

---

## External Memory

External memory is disabled by default. The implemented provider is file-backed and profile-local under:

```text
~/.estacoda/profiles/<id>/external-memory/
```

External recall is untrusted reference context. External memory cannot replace `USER.md`, `MEMORY.md`, `SOUL.md`, shared memory, `promotions.json`, or session recall.

---

## Troubleshooting

| Symptom | Likely cause | First check |
|---|---|---|
| Expected preference did not promote | It was seen fewer than two prior root sessions, used an unsupported phrase, or appeared only in delegated/quoted/resume text | Check root-session history and phrase shape |
| Arabic or mixed-language phrase did not promote | The value was natural-language text instead of a supported technical token, or contained bidi/invisible controls | Try a supported form such as `أفضل TypeScript` or `استخدم pnpm test افتراضياً` |
| Wrong memory appeared | Active promotion metadata and markdown may disagree, or an old active promotion is still present | Inspect `USER.md`, `MEMORY.md`, and `promotions.json` |
| Auto memory did not write | Curation mode is `review` or `manual`, the fact was not explicit, was sensitive, duplicated existing memory, failed the scanner, exceeded budget, lacked evidence, or had confidence below `0.7` | Run `estacoda memory recent`, `estacoda memory review`, and `estacoda memory mode` |
| `/memory populate` says no active runtime | The top-level command was run outside an attached runtime | Run `/memory populate` inside an active CLI session or authorized Telegram session |
| Memory file changed externally | Drift detection refused the write | Restart the runtime or reconcile the manual edit before retrying |
| Memory write failed | Scanner rejection, budget overflow, drift, or persistence error | Check diagnostics and file sizes; compact or edit memory if needed |
| Secret-looking content did not save | Safety scanner rejected it | Keep credentials in `.env` or secret storage, not memory |
| Index search is stale | Rebuildable lexical index is out of date | Run `estacoda memory index rebuild` |

When debugging curation, start with `memory recent` and `memory review`, then inspect `USER.md` or `MEMORY.md`. When debugging deterministic promotion, start with the current direct user input, then check matching root-session user messages, then inspect `promotions.json`.

---

## Related

- [Profiles](./profiles.md) - profile-local state and memory isolation
- [Sessions](./sessions.md) - session history and recall boundaries
- [Runtime](../developer/runtime.md) - runtime creation and prompt assembly
- [Memory architecture](../developer/memory-architecture.md) - implementation details
- [Security and Approvals](./security-and-approvals.md) - trust boundaries
