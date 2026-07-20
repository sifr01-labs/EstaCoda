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
| `image.generate` / `image.edit` | `external-side-effect` | Requires image provider credentials; editing also requires an edit-capable selected model |
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

`delegate_task` creates background Tasks for independent inspection, research, or coding work. It returns a Task handle immediately, so the creating conversation does not have to stay open until the work finishes.

Single and batch inputs keep the same shape:

```json
{
  "tasks": [
    { "task": "Inspect config defaults." },
    { "task": "Inspect gateway behavior.", "allowedTools": ["file.read", "file.grep"] }
  ]
}
```

A batch becomes one durable Task with one independent Step per item. The scheduler enforces configured concurrency, timeout, retry, cancellation, usage, approval, and result policies. The tool result contains the Task ID, queued status, Step count, and whether the call created a root or linked child Task.

Add an explicit fixed synthesis Step when the Task should return one combined answer:

```json
{
  "tasks": [
    { "task": "Research option A." },
    { "task": "Research option B." },
    { "task": "Research option C." }
  ],
  "synthesis": {
    "objective": "Compare the durable worker results and return one recommendation."
  }
}
```

The initial immutable plan contains all workers and one terminal synthesis Step. Synthesis waits for every worker, reads their bounded Result handles with `task.result.read`, and cannot delegate. If a worker fails, synthesis is skipped and the Task becomes `partial`. If it succeeds, its Result is shown as the primary Result and completion delivery expands only that answer; intermediate worker Results remain readable by handle.

Delegated authority is deliberately narrower than the creating runtime. Parent-visible tools are intersected with the requested tools and default risk policy before the Step is persisted. Worker Steps cannot delegate. Orchestrator Steps may create linked child Tasks only while their persisted authority retains child depth; the child workspace, authority, and budget cannot exceed the active parent Step.

Provider tool-call IDs make creation idempotent. Replaying the same call returns the existing Task; reusing the identity for a different definition fails closed. `delegate_task` is unavailable when profile-bound durable Task storage is unavailable—there is no in-memory fallback.

Use `task.status` with the returned Task ID to inspect bounded progress from a linked session. It reports Step counts, active work, usage completeness, and result handles without exposing local paths, prompts, tool inputs, credentials, or full result bodies.

Worker sessions are created only after the scheduler leases a Step. They remain isolated from parent prompt packing, recall, session search, and canonical memory. Model overrides are stored on the Step and validated through the existing configured provider and credential path when the worker is constructed.

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
