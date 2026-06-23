---
title: Tools
description: Tool system, availability, execution, and failure modes for v0.1.0.
sidebar_position: 5
---

# Tools

Tools are bounded execution surfaces that extend what the agent can do. Every tool call routes through the runtime, passes security policy, and returns a structured result. There is no ungated tool execution.

This page explains how tools are organized, when they are available, and what happens when they fail.

---

## What Tools Are

A tool is a function the agent can invoke. Tools read files, write files, search the web, execute code, manage memory, schedule cron jobs, and perform other operations. Each tool has a risk class, a schema, and a runtime implementation.

Tools are not free capabilities. They are gated by configuration, provider readiness, workspace trust, and security mode.

---

## Tool Categories

### Built-In Tools

Built-in tools ship with EstaCoda and are always registered. Availability depends on configuration and provider state.

| Tool | Risk Class | Notes |
|---|---|---|
| `file.read` | `safe` | Reads files within the workspace |
| `file.write` | `caution` | Writes files; gated in adaptive/strict mode |
| `file.replace` | `caution` | Edits files; gated in adaptive/strict mode |
| `file.search` | `safe` | Simple compatibility search for literal or regex queries |
| `file.glob` | `read-only-local` | Finds workspace files by glob pattern |
| `file.grep` | `read-only-local` | Bounded ripgrep-backed content search |
| `notebook.edit` | `workspace-write` | Edits cells in workspace `.ipynb` notebooks |
| `web.search` | `read-only-network` | Web search via configured provider |
| `web.extract` | `read-only-network` | Extracts content from URLs |
| `web.crawl` | `read-only-network` | Crawls web pages |
| `browser.*` | `external-side-effect` | Requires browser backend config |
| `image.generate` | `external-side-effect` | Requires image provider credentials |
| `voice.speak` | `external-side-effect` | Requires configured TTS; credentials depend on provider |
| `voice.transcribe` | `safe` | Requires STT provider or local model |
| `execute_code` | `caution` | Executes code in a sandbox |
| `memory.*` | `safe` | Memory curation and compaction |
| `session_search` | `read-only-local` | Raw historical session browse/search/scroll |
| `skill.*` | `safe` | Skill CRUD operations |
| `cronjob` | `caution` | Schedules and manages cron jobs |

### Provider-Backed Tools

Provider-backed tools are not standalone. They are requests the provider makes through the tool-calling protocol. The runtime resolves the tool name, validates the schema, and executes the implementation. If the provider does not support tool calling, tool execution is unavailable.

### MCP Tools

MCP (Model Context Protocol) tools are loaded from configured MCP servers. They are registered at runtime startup and refreshed with `/reload-mcp`. If an MCP server is missing or misconfigured, its tools are unavailable.

### Skill-Selected Tool Use

Skills can declare required toolsets. When a skill is visible in a session, its required toolsets are checked for availability. If a toolset is missing, the skill may still be visible but its instructions will note the limitation.

---

## Workspace File Search

Use the workspace file tools when the task is about code, local documentation, fixtures, notebooks, or any other file under the active workspace. All paths remain scoped to the active workspace. Traversal such as `../outside` and absolute paths outside the workspace are rejected before the tool reads, writes, or spawns a search process.

These tools do not change workspace trust semantics. `file.glob` and `file.grep` are read-only local tools. `notebook.edit` is a workspace-write tool.

### `file.search`

`file.search` is the simple fallback and compatibility search tool. Use it for a straightforward literal or regex query when you do not need ripgrep-specific filtering, output modes, context, or pagination.

What can go wrong:

- Invalid regex input is rejected.
- Very broad searches are less ergonomic than `file.grep`.
- It is not the right tool for notebook cell edits or glob-only file discovery.

Recovery: narrow the query or path. For larger repositories, prefer `file.grep` for content search and `file.glob` for file discovery.

### `file.glob`

`file.glob` finds files by glob pattern and returns workspace-relative paths. It uses `rg --files -g <pattern>` when ripgrep is installed. That path is fast on large repositories and respects `.gitignore`. When ripgrep is unavailable, EstaCoda uses a smaller Node fallback that supports `*`, `**`, `?`, and basic `{a,b}` groups.

Behavior:

- Hidden files are excluded by default.
- `include_hidden: true` can include non-sensitive hidden files.
- Secret-ish files are still excluded even when hidden files are enabled.
- Generated and VCS directories are excluded.
- Results are sorted by path by default; `sort: "modified"` sorts by descending file modification time.
- `limit` and `offset` apply after sorting.

Secret exclusions include `.env`, `.env.*`, `*.pem`, `*.key`, SSH keys such as `id_rsa` and `id_ed25519`, `*.p12`, and `*.pfx`. Generated and VCS exclusions include `.git`, `node_modules`, `dist`, `build`, `.next`, `.turbo`, and similar folders.

What can go wrong: a pattern may match nothing, the scoped path may be a file instead of a directory, or the Node fallback may not support a more advanced glob dialect. Recovery: check the path scope, simplify the glob, or use `file.grep` if the real goal is content search.

### `file.grep`

`file.grep` searches file contents with ripgrep. Use it when you need content matches with filtering, output modes, context, pagination, or bounded result sizes. It uses `rg` directly and does not implement a Node content-search fallback. If ripgrep is missing, the tool returns a clear error; use `file.search` as the simpler fallback.

Behavior:

- The search target is resolved under the active workspace and passed to `rg` as a workspace-relative path.
- The pattern is passed through `-e`.
- `glob` maps to `--glob`.
- `type` maps to `--type`.
- `ignore_case` maps to `-i`.
- `multiline` maps to `-U --multiline-dotall`.
- Binary files are skipped by ripgrep default.
- Hidden files are excluded by default; `include_hidden: true` passes `--hidden`.
- Built-in secret and generated-directory exclusions still apply when hidden files are enabled.

Output controls:

| Input | Behavior |
|---|---|
| `limit` | Defaults to `50`; bounds logical result rows. |
| `offset` | Defaults to `0`; skips logical rows before rendering. |
| `max_result_chars` | Defaults to `100000`; caps rendered output. |
| `max_line_chars` | Defaults to `500`; truncates long match lines. |
| `max_filesize` | Defaults to `2M`; passed to ripgrep as `--max-filesize`. |

Output modes:

- `content` is the default. It includes line numbers by default. Context flags apply only in this mode.
- `files` returns matching file paths.
- `count` returns per-file match counts.

Timeout behavior: `file.grep` uses a `30000ms` timeout. On timeout or abort, the spawned ripgrep process is killed and the tool returns a structured error or truncated result metadata.

What can go wrong: a regex can be invalid, output can be truncated, `rg` may be missing, or exclusions can intentionally hide secret/generated files. Recovery: narrow `pattern`, `glob`, or `path`; increase `offset`; use `output_mode: "files"` to inspect the match set; or fall back to `file.search` when ripgrep is unavailable.

---

## Notebook Editing

`notebook.edit` edits cells in Jupyter `.ipynb` notebooks scoped to the active workspace. Prefer workspace-relative `.ipynb` paths in prompts and examples. The tool follows the same workspace containment model as `file.read`: paths that resolve outside the workspace, including traversal and absolute paths outside the workspace, are rejected. Non-notebook paths are rejected.

The tool reads the notebook as UTF-8 JSON and validates the minimal notebook shape:

- The root is an object.
- `cells` is an array.
- `nbformat` is numeric.
- `nbformat_minor` is numeric.

Edit modes:

| Mode | Behavior |
|---|---|
| `replace` | Requires `cell_id` and `new_source`; replaces the target cell source. |
| `insert` | Requires `new_source`; inserts at the beginning when `cell_id` is omitted, or after the target cell when provided. |
| `delete` | Requires `cell_id`; removes the target cell. |

Cell lookup prefers real notebook cell IDs. If needed, `cell-N` addresses the zero-based cell index. Inserted cells default to `cell_type: "code"` unless `cell_type: "markdown"` is explicitly provided. Inserted code cells include the minimal valid code-cell fields; markdown cells do not get code output fields. When the notebook format supports cell IDs, inserted cells receive generated IDs.

Replacing a code cell resets `execution_count` and `outputs` to `[]`. Replacing a markdown cell does not invent code outputs. Unknown notebook-level and cell-level fields are preserved.

Use `expected_mtime_ms` to guard against stale edits. If the notebook changed since that timestamp, the tool rejects the edit. Successful writes use a temp file plus rename and return concise metadata plus `fileChangePreview`.

What can go wrong: invalid JSON, invalid notebook shape, stale `expected_mtime_ms`, missing `cell_id`, or an invalid `cell-N` reference. Recovery: read or inspect the notebook again, use a real cell ID when present, or retry with the current `mtime` metadata.

---

## Session Search

`session_search` is a read-only tool for deterministic browsing, searching, and scrolling of historical sessions. It returns raw historical reference context; it does not summarize, does not use an auxiliary/model provider, and does not make old session content authoritative.

Use it to locate prior sessions or messages. Treat output as untrusted reference material. Current user instructions, runtime policy, and security rules outrank historical session content.

Controls are intentionally small:

| Mode | Controls |
|---|---|
| `browse` | `limit`, `sort` |
| `search` | `query`, `limit`, `sort`, `role_filter` |
| `scroll` | `session_id`, `around_message_id`, `window` |

`browse` and `search` default to `10` results and clamp at `20`. `scroll` defaults to a `5` message window and clamps at `20`. The tool does not expose `maxChars`; message excerpts, session previews, and total output are capped internally. Output is bounded, redacted, source-labeled, and marked as untrusted historical reference context. Missing sessions or messages return structured diagnostics.

---

## Delegating Tasks

`delegate_task` lets EstaCoda start bounded child agents for subtasks while the parent turn continues to own the final answer. Use it when a task can be split into independent inspection or research work.

Single task:

```json
{
  "task": "Read the runtime tests and report the risky assumptions.",
  "context": "Focus on behavior, not style.",
  "role": "leaf"
}
```

Batch tasks:

```json
{
  "tasks": [
    { "task": "Inspect config defaults." },
    { "task": "Inspect gateway interrupt behavior." },
    { "task": "Inspect delegation timeout behavior." }
  ]
}
```

Batch results come back in the same order as the input tasks. Parallelism is bounded by runtime config, so a batch can run more than one child at once without exceeding `maxConcurrentChildren`.

Child agents are intentionally narrower than the parent. By default they can use parent-visible read-only local and read-only network tools, such as file reads/searches, process logs/listing, web research, and `terminal.inspect` when that tool is parent-visible. They do not receive workspace-write, memory/session search, skill mutation, config mutation, cron mutation, trust mutation, browser, media, MCP, credential, process-control, or general shell execution tools. `terminal.run` is excluded by default.

`leaf` children cannot spawn more children. `orchestrator` children may delegate only while under the configured depth limit. Requests beyond the depth limit fail before a new child session is created.

Child approvals are non-interactive and fail closed. A child does not inherit parent approval grants or pending approval queues. If an action would need approval, the child denies it instead of asking.

If a child times out or is cancelled, the result is structured. Timeout diagnostics are written under profile-local diagnostics paths when enabled. Prompt previews are off by default, and diagnostics are bounded and redacted. Long-running child work emits bounded progress and heartbeat metadata so the parent turn stays observable without exposing raw provider token streams.

Gateway behavior is also protected: if a remote channel is configured to interrupt active turns, ordinary messages are queued while the active turn has child work running. Explicit control commands such as `/stop` still cancel the active turn and active child work.

Delegation results include structured status/reason metadata, child session ids where created, effective child tool metadata, timeout/cancelled details, batch indexes, stale-file warnings, and provider token usage when available. Batch token usage rolls up numeric usage fields and marks unavailable usage explicitly. Durable or estimated USD cost accounting is not shipped.

Child model overrides are supported through `modelOverride`. Same-provider overrides and reviewed cross-provider child routes use existing configured providers only; they do not create credential pools. Cross-provider overrides preserve target provider config, reject disabled-network routes before child execution, and disable fallbacks for the overridden child.

Delegation outcome memory is configurable and disabled by default. When enabled, it records bounded task preview and deterministic status/reason metadata only. It does not store raw child output, prompts, transcripts, tool arguments, file contents, or diagnostic payloads.

Stale-file warnings are advisory. EstaCoda snapshots parent file reads before delegation; if a child writes, replaces, or deletes a tracked file the parent already read, the result includes a warning. The warning does not change success/failure status. Shell/process writes are not detected unless represented through the file-state tracker.

Parent-mediated child approvals are not shipped. Children remain non-interactive and fail closed for approval-required actions.

## Read-Only Terminal Inspection

`terminal.inspect` is a bounded read-only terminal inspection tool. It accepts argv arrays, runs without a shell, and is not a general command runner.

```json
{ "argv": ["git", "status", "--short"] }
```

Allowed commands are `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `file`, `git status`, `git diff`, `git log`, `git branch`, `git remote`, `git ls-files`, and `git grep`. `git show` is not allowed.

The tool rejects shell wrappers, pipes, redirection, command chaining, command substitution, environment assignment, package scripts, interpreters, arbitrary binaries, mutating commands, unsupported glob arguments, and paths outside the workspace. Output is bounded and redacted. `terminal.inspect` may be available to children only through the same parent-visible, read-only child tool policy; `terminal.run` remains excluded from default child schemas.

---

## Tool Execution Flow

1. Provider requests a tool call.
2. `ToolCallPlanner` converts the request to a `ToolCallPlan`.
3. `ToolExecutor` runs the tool under the active `SecurityPolicy`.
4. The result is packetized and returned to the provider.

Security policy runs before execution. The hardline floor blocks dangerous commands before the tool implementation runs. Adaptive mode may prompt for approval. Open mode allows non-hardline actions with minimal gating.

---

## Tool Availability

A tool is available only when:

- It is registered in the tool registry.
- Its required configuration is present (provider credentials, browser backend, etc.).
- The provider route is ready and runnable.
- Workspace trust does not block it.
- Security mode permits its risk class.

`/tools` inside an interactive session lists currently available tools. `/skills` lists visible skills and their required toolsets.

---

## Failure Modes

**Tool unavailable:** The tool is not registered or its configuration is missing. Check `/tools` for availability. Verify required provider credentials, endpoint reachability, browser backend config, or MCP server status.

**Approval required:** The tool's risk class triggered an approval gate. Respond to the prompt or use `/approvals` to inspect pending grants.

**Denied by hard safety block:** The command matched a hardline pattern. The tool does not execute. Change the command; the block is unconditional.

**Missing provider key:** A credentialed provider-backed tool requires credentials that are not configured. Run `estacoda model setup` or set the required env var in the profile `.env`. No-auth provider routes do not need a key.

**Unsupported provider stub:** The provider advertises tool calling but the runtime does not yet implement the tool schema for that provider. Use a different provider or a built-in tool.

**Tool execution error:** The tool ran but encountered an error (file not found, network timeout, invalid regex). The error is returned to the provider as a structured result.

---

## Inspection

```bash
# List available tools in session
/tools

# List visible skills and toolsets
/skills

# Reload MCP servers
/reload-mcp

# Security audit
/security debug
```

---

## Related

- [Security and Approvals](./security-and-approvals.md) — risk classes and approval modes
- [Skills](./skills.md) — skill-required toolsets
- [CLI](./cli.md) — interactive tool listing and approval prompts
- [Channels](./channels.md) — channel tool availability
