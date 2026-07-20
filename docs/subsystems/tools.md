---
title: "Tools"
description: "Tool system: registry, schemas, execution, and builtin tools."
---

# Tools

Tools are functions that extend the agent's capabilities. They are organized into a registry with risk-based gating.

## Files

| File | Role |
|------|------|
| `src/tools/tool-registry.ts` | Register and resolve tools |
| `src/tools/tool-executor.ts` | Execute tool calls |
| `src/tools/tool-call-planner.ts` | Convert provider calls to plans |
| `src/tools/tool-schema.ts` | Build OpenAI-compatible schemas |
| `src/tools/tool-result-packet.ts` | Packetize tool results |
| `src/tools/builtin-tools.ts` | Built-in tool-provider assembly |
| `src/tools/workspace-tools.ts` | File read/write/edit/simple search and bounded terminal commands |
| `src/tools/glob-tools.ts` | Workspace file globbing |
| `src/tools/grep-tools.ts` | Bounded ripgrep-backed workspace grep |
| `src/tools/notebook-tools.ts` | Jupyter notebook cell edits |
| `src/tools/web-tools.ts` | Web search/extraction/crawl wrappers and browser tool schemas |
| `src/tools/execute-code-tool.ts` | Code execution |
| `src/tools/vision-tools.ts` | Image analysis |
| `src/tools/media-tools.ts` | Media handling |
| `src/tools/session-search-tool.ts` | Deterministic raw historical session browse/search/scroll |
| `src/tools/skill-tools.ts` | Agent-facing skill listing, review, proposal, edit, import, export, and rollback tools |
| `src/tools/delegation-tools.ts` | Durable Task creation for delegated work |
| `src/tools/task-tools.ts` | Bounded, session-authorized durable Task status |
| `src/tools/memory-file-compaction-tools.ts` | Manual memory-file compaction and restore tools |
| `src/tools/workspace-trust-tools.ts` | Workspace trust inspection and grant/revoke tools |

## Representative Builtin Tools

The runtime assembles tools from provider modules at startup. Treat this table as an operator map of important tool families; inspect the files above for the exact registered tool list in a given build.

| Tool | Risk | Evidence |
|------|------|----------|
| `file.read` | `safe` | `live-proven` |
| `file.write` | `caution` | `live-proven` |
| `file.patch` | `caution` | `live-proven` |
| `file.search` | `safe` | `smoke-tested` |
| `file.glob` | `read-only-local` | `smoke-tested` |
| `file.grep` | `read-only-local` | `smoke-tested` |
| `terminal.run` | `workspace-write` | `smoke-tested` |
| `notebook.edit` | `workspace-write` | `smoke-tested` |
| `web.search` | `read-only-network` | `smoke-tested` |
| `web.extract` | `read-only-network` | `smoke-tested` |
| `web.crawl` | `read-only-network` | `smoke-tested` |
| `browser.*` | `external-side-effect` | `smoke-tested` |
| `image.generate` | `external-side-effect` | `live-proven` |
| `voice.speak` | `external-side-effect` | `smoke-tested` |
| `voice.transcribe` | `safe` | `smoke-tested` |
| `execute_code` | `caution` | `smoke-tested` |
| `memory.curate` | `workspace-write` | `smoke-tested` |
| `memory.read` | `read-only-local` | `smoke-tested` |
| `memory.search` | `read-only-local` | `smoke-tested` |
| `memory.file_compact` | `workspace-write` | `smoke-tested` |
| `session_search` | `read-only-local` | `smoke-tested` |
| `skill.*` | `safe` | `smoke-tested` |
| `delegate_task` | `shared-state-mutation` | `smoke-tested` |
| `task.status` | `read-only-local` | `smoke-tested` |
| `workspace.trust.*` | `read-only-local` / `shared-state-mutation` | `smoke-tested` |
| `cronjob` | `caution` | `smoke-tested` |

## Workspace File Tools

Workspace file tools are scoped to the active workspace. User-provided paths are resolved through the shared containment helper. Traversal outside the workspace is rejected before filesystem mutation or command execution. These tools do not change workspace trust semantics: read-only tools remain read-only local tools, and write tools remain workspace-write tools.

### `file.patch`

`file.patch` is the targeted edit tool. Replace and insert modes try exact matching first, then deterministic fuzzy fallbacks for small whitespace, indentation, escaping, and Unicode differences. A match must be unique unless `replace_all: true` is explicit, and overlapping fuzzy matches fail closed before any write. Successful anchor matches report the selected strategy, confidence, and a bounded matched snippet.

Append and prepend modes add content to an existing or new text file without replacing the whole file. Insert mode places content before or after a matched anchor.

Patch mode accepts V4A-style `*** Begin Patch` / `*** Update File` / `*** Add File` / `*** Delete File` / `*** End Patch` content for multi-file changes. It validates every file and hunk before writing, so a failed hunk, missing delete target, existing add target, or JSON syntax failure leaves all targeted files unchanged. If a later filesystem write/delete fails after some files were already changed, `file.patch` rolls back those prior changes and reports rollback metadata.

Patch failures are counted per target file within the active tool provider. After the third consecutive failure on the same file, the tool response tells the model to stop retrying and re-read the file before attempting another patch.

### `file.write`

`file.write` creates complete text files and can replace an entire file when that is explicitly intended. Creates do not require extra intent. Same-content writes are treated as no-op successes.

Changing an existing file requires `overwrite: true`; otherwise the tool returns a structured failure with byte deltas and a bounded change preview without modifying the file. Large suspicious shrink overwrites, such as replacing a long transcript or markdown document with a tiny summary, are blocked even with `overwrite: true` unless `allowShrink: true` is also explicit.

Use `file.patch` for targeted edits to existing files. Use `file.write` with overwrite intent only when replacing the whole file is the desired operation.

### `file.search`

`file.search` is the compatibility search tool. It is useful for simple literal or regex searches when ripgrep-specific filtering, pagination, or output modes are not needed. It remains intentionally smaller than `file.grep`.

Failure and recovery are straightforward: invalid regexes are rejected before execution, missing paths return structured tool errors, and broad searches should be narrowed by path or query.

### `file.glob`

`file.glob` finds workspace files by glob pattern. It uses `rg --files -g <pattern>` when ripgrep is available, which makes it fast on large repositories and lets ripgrep respect `.gitignore`. If ripgrep is missing, it falls back to a smaller Node traversal implementation that supports `*`, `**`, `?`, and basic `{a,b}` groups.

Hidden files are excluded by default. `include_hidden: true` passes `--hidden` in the ripgrep backend and includes non-sensitive hidden files in the Node fallback. Secret-ish files remain excluded even when hidden files are enabled: `.env`, `.env.*`, `*.pem`, `*.key`, SSH keys such as `id_rsa` and `id_ed25519`, `*.p12`, and `*.pfx`. Generated and VCS directories are always excluded, including `.git`, `node_modules`, `dist`, `build`, `.next`, `.turbo`, and similar folders.

Results are workspace-relative paths, sorted by path by default. `sort: "modified"` stats matched files and sorts by descending modification time. `limit` and `offset` apply after sorting. If results are missing, check the glob, path scope, hidden-file setting, generated-directory exclusions, and whether ripgrep or the Node fallback is active.

### `file.grep`

`file.grep` is the ripgrep-backed content search tool. Use it when file filtering, output modes, context, pagination, case handling, or bounded output matters. It always runs `rg` with the active workspace as `cwd` and passes the scoped workspace-relative target path to ripgrep. It does not implement a Node content-search fallback; if ripgrep is missing, the tool returns a clear error and `file.search` remains the simple fallback.

`file.grep` skips binary files by ripgrep default. It excludes hidden files by default. `include_hidden: true` can include non-sensitive hidden files, but built-in secret exclusions still apply. The same generated and VCS exclusions used by `file.glob` apply to the actual ripgrep search and to output filtering.

Output is bounded:

- `limit` defaults to `50` and is clamped to the tool maximum.
- `offset` skips logical result rows before output rendering.
- `max_result_chars` defaults to `100000` and is capped by the tool.
- `max_line_chars` defaults to `500`; long match lines are truncated.
- `max_filesize` defaults to `2M` and is passed to ripgrep with `--max-filesize`.
- Execution times out after `30000ms`; the child process is killed on timeout or abort.

Supported output modes are content, files, and count. Content mode includes line numbers by default and is the only mode where before/after context applies. If output is truncated, narrow `pattern`, `glob`, or `path`, increase `offset`, or use `output_mode: "files"` to inspect the match set before requesting content.

### `notebook.edit`

`notebook.edit` edits Jupyter `.ipynb` files scoped to the active workspace. Prefer workspace-relative notebook paths in tool calls and examples. The tool uses the same containment model as `file.read`: paths that resolve outside the workspace, including absolute paths outside the workspace and `..` traversal, are rejected. Non-`.ipynb` paths are rejected.

The tool parses UTF-8 JSON and requires a minimal notebook shape: root object, `cells` array, numeric `nbformat`, and numeric `nbformat_minor`. Invalid JSON and invalid notebook shape return clear errors.

Edit modes:

- `replace` requires a valid `cell_id` and `new_source`.
- `insert` requires `new_source`; without `cell_id` it inserts at the beginning, and with `cell_id` it inserts after that cell.
- `delete` requires a valid `cell_id` and does not require `new_source`.

Cell lookup prefers real notebook cell IDs. `cell-N` is supported as a zero-based fallback for notebooks without cell IDs or for model-friendly index references. Inserted cells default to `cell_type: "code"` unless `cell_type: "markdown"` is provided. For notebook formats that support cell IDs, inserted cells receive generated IDs.

Unknown notebook-level and cell-level fields are preserved. Replacing a code cell source resets `execution_count` and `outputs` to `[]`; replacing markdown cells does not add code outputs. `expected_mtime_ms` provides a stale-edit guard. Writes use a temp file plus rename, and successful results include concise metadata and a `fileChangePreview`.

## Voice Tools

`voice.speak` and `voice.transcribe` use boolean-only tool availability. Human-readable readiness reasons are exposed through exported helpers and CLI/status surfaces, not through `RegisteredTool.isAvailable()`.

Implemented voice providers and security boundaries are documented in [Voice](./voice.md). In short:

- Hosted TTS: OpenAI, ElevenLabs, MiniMax, Gemini, xAI, and Edge. Edge does not require an API key, but it sends synthesis text to Microsoft's Edge speech service and is not local/offline.
- Hosted STT: OpenAI, Groq, and xAI.
- Local STT: managed faster-whisper by default for `stt.provider: "local"`; command mode only with explicit `stt.local.engine: "command"`.
- Deferred: local TTS providers `neutts` and `kittentts`, and Mistral TTS/STT.

Voice config stores env-var references only. Guided setup collects hosted provider API keys through masked input, writes profile-local `.env` secrets only after reviewed apply, and keeps raw keys out of config, review manifests, prompt context, logs, and tool errors. Tool errors use stable provider/reason metadata and bounded sanitized snippets.

## Memory Retrieval Tools

`memory.read` and `memory.search` are deterministic read-only-local tools for bounded local lexical memory retrieval. They use the local memory retrieval service, not `SessionRecallService`, and they do not call auxiliary/model providers or summarize content.

| Tool | Inputs | Behavior |
|------|--------|----------|
| `memory.read` | `source`, `key`, `includeProtected`, `maxChars` | Reads bounded local memory context by source |
| `memory.search` | `query`, `includeProtected`, `maxResults`, `maxChars` | Searches local memory lexically |

`maxChars` is accepted and bounded internally. `memory.search` also accepts `maxResults`, which is bounded internally. Output is redacted, source-labeled, marked as `local-memory-context`, and treated as context rather than instruction. Diagnostics are structured and do not expose raw memory content.

Protected memory remains excluded by default. `SOUL.md` is indexed as protected and is returned only when `includeProtected` is explicit. If the local index is disabled or unavailable, the retrieval service falls back to safe substring read/search while preserving protected filtering.

`session_search` is separate: it browses/searches historical sessions, does not expose `maxChars`, and returns untrusted historical reference context. `memory.read` and `memory.search` read/search local memory files and shared memory. Neither surface upgrades returned content into higher-priority instruction.

## Session Search Tool

`session_search` is a deterministic read-only-local tool for raw historical session browse/search/scroll. It uses `SessionSearchService` and stays separate from `SessionRecallService`. It does not call auxiliary/model providers, does not summarize, and does not make historical content authoritative.

Modes:

| Mode | Inputs | Behavior |
|------|--------|----------|
| `browse` | `limit`, `sort` | Lists recent sessions for the active profile/workspace where available |
| `search` | `query`, `limit`, `sort`, `role_filter` | Searches historical messages |
| `scroll` | `session_id`, `around_message_id`, `window` | Returns a deterministic message window around a message id |

The schema exposes result/message-count knobs only: `limit` and `window`. It must not expose `maxChars`; text-size caps are system-controlled internally. `browse` and `search` default to `10` results and clamp at `20`. `scroll` defaults to a `5` message window and clamps at `20`. Per-message excerpts, session previews, and total tool output are internally capped by the service and the registered tool `maxResultSizeChars`.

Output is bounded, redacted, source-labeled, and explicitly marked as untrusted historical reference context. Historical content is useful for locating prior work, but it is not current instruction authority. Current user instructions and runtime policy outrank historical session content. Profile/workspace filtering is applied where available, active/current session exclusion is used where configured or available, and missing sessions/messages return structured diagnostics.

## Delegation Tool

`delegate_task` creates a fixed durable Task graph and returns its handle immediately. It does not run or await a child inside the provider turn. A single request creates one Step; a batch creates independent Steps under one Task. The durable scheduler owns execution, concurrency, cancellation, recovery, results, usage, and settlement.

Single-task input:

```json
{
  "task": "Inspect the failing test and summarize the likely cause.",
  "context": "Keep the answer short.",
  "role": "leaf"
}
```

Batch input:

```json
{
  "tasks": [
    { "task": "Inspect config tests." },
    { "task": "Inspect runtime tests.", "role": "leaf" },
    { "task": "Inspect gateway tests.", "allowedTools": ["file.read", "file.grep"] }
  ]
}
```

Fixed fan-out with synthesis:

```json
{
  "tasks": [
    { "task": "Research option A." },
    { "task": "Research option B." },
    { "task": "Research option C." }
  ],
  "synthesis": {
    "objective": "Compare all three durable worker results and return one supported recommendation."
  }
}
```

When `synthesis` is present, revision 1 contains every independent worker Step plus one `synthesis` agent Step that depends on all of them. The graph is fixed before execution; no running worker may insert a dependency. The synthesis Step receives only bounded dependency metadata and opaque result handles, reads bodies through `task.result.read`, cannot delegate, and becomes runnable only after every worker completes. A terminal worker failure skips synthesis and settles the Task `partial`. The synthesis Result is marked primary on status/UI surfaces and is the only body expanded by completion delivery; intermediate Results remain available by handle.

When `recoverJsonStringTasks` is enabled, `tasks` may be a JSON string containing an array of task objects. Recovery is strict: each object must contain only `task`, `context`, `allowedToolsets`, `allowedTools`, `role`, and `modelOverride`; `context` must be a string when present; tool lists must be arrays of strings; `role` must be `leaf` or `orchestrator`; model overrides must be bounded strings.

Default Step capability is risk-class based. After intersecting with parent-visible tools, delegated Steps receive `read-only-local` and `read-only-network` tools unless exact names, prefixes, or excluded toolsets strip them. Browser, media, and MCP toolsets are excluded by default. Workspace-write, credential, process-control, memory/session search, skill mutation, config mutation, cron mutation, trust mutation, and dangerous shell/process tools are stripped before the authority policy is persisted. `terminal.run` is excluded by default. `terminal.inspect` may remain visible through the parent-visible read-only policy.

Roles, depth, and the Step's immutable child policy are enforced at Task creation and again before worker schemas are built. A worker Step is `forbid` and cannot see `delegate_task`. An orchestrator Step may use `fire_and_forget` only with persisted child-creation authority and remaining depth. A nested call creates a detached linked child Task whose authority, budget, workspace, parent/root Task, parent Attempt, and origin attribution are validated atomically. The same transaction reserves the child's provider-call, token, and cost ceilings against the parent Step; repeated calls share that one ceiling. Tree-wide wall-clock and live-concurrency checks remain hard ceilings. The child cannot silently add a required dependency to the parent PlanRevision.

Worker runtimes use the Task approval policy. Hardline denies run first; an authorized ask is persisted against the Task, Step, and Attempt and releases the lease while waiting.

Batch delegation is bounded by `maxBatchTasks` and `maxConcurrentChildren`. The configured batch size is hard-capped at 10 Steps. Step order is stable, while the Task scheduler runs eligible Steps concurrently and derives `completed`, `partial`, `failed`, or `cancelled` terminal state. A per-turn `maxDelegateCallsPerTurn` cap bounds separate creation calls.

The model-facing result is a bounded handle containing Task ID, queued status, Step count, worker Step IDs, optional synthesis/primary-result Step ID, root/child relationship, and replay status. Full Step outputs are stored by the Task result plane rather than copied into the creating provider turn.

Attempt heartbeat, timeout, lease, and progress diagnostics are structured and bounded. They do not make the creating provider turn the owner of background execution.

### `task.status`

`task.status` accepts a Task ID and returns a bounded profile-scoped projection for a session linked to that Task. It includes status, Step counts, active Attempt count, usage/pricing completeness, and opaque result metadata. It excludes workspace paths, prompts, tool inputs, credentials, full result bodies, and raw failure messages. Missing, cross-profile, and unauthorized Tasks share the same error so identifiers do not become an authorization oracle.

Task status, result bodies, approval waits, worker-session links, and structured provider usage remain profile-owned durable records. Worker sessions are created only after the scheduler leases a Step.

Delegation outcomes are recorded in the Task journal and worker trajectories. They are not written to canonical prompt memory.

Tracked file tools continue to record structured reads and writes for diagnostics. The removed synchronous parent-result stale-file warning path is not retained as a second lifecycle architecture.

Child model overrides support same-provider model selection and reviewed cross-provider routes. Target provider config is preserved, credentials resolve through the existing `apiKeyEnv` path, `authMethod: "none"` is allowed when configured, `enableNetwork: false` rejects before child execution, and child fallbacks are disabled for overrides. Metadata is bounded/redacted.

## Terminal Inspection Tool

`terminal.inspect` is a read-only-local terminal inspection tool. It is not a general shell and does not replace `terminal.run`.

Input is argv-only:

```json
{ "argv": ["git", "status", "--short"] }
```

Allowed commands are:

- `pwd`
- `ls`
- `cat`
- `head`
- `tail`
- `wc`
- `stat`
- `file`
- `git status`
- `git diff`
- `git log`
- `git branch`
- `git remote`
- `git ls-files`
- `git grep`

`git show` is not allowed. Git commands are hardened against repo/global/system helper execution, run with disabled prompts/pagers/editors, and reject revision/object path syntax that could escape the workspace.

The tool rejects shell wrappers, command chaining, pipes, redirection, command substitution, environment assignment, package scripts, interpreters, arbitrary binaries, mutating commands, unsupported glob arguments, and paths outside the workspace root. Output is bounded and redacted before it is returned or persisted.

## Tool Execution

1. Provider requests tool call
2. `ToolCallPlanner` converts to `ToolCallPlan`
3. `ToolExecutor` runs the tool under `SecurityPolicy`
4. Result is packetized and returned to the provider

Provider-native replay adds one persistence rule to this flow: after the provider response is finalized and missing IDs are normalized, the assistant tool-call turn is persisted before planning/execution. The persisted turn records `metadata.kind: "provider-tool-call-turn"` and the same stable IDs that `ToolCallPlanner` will use. Tool result messages continue to carry `metadata.tool_call_id`.

No synthetic tool results are created by the replay layer. If a call is invalid, blocked, denied, over budget, or execution-failed, that outcome remains the existing tool planning/execution result. Native history builders may later represent known missing results for provider protocol repair, but the tool runtime does not pretend a tool ran.

Replay safety is turn-level. If any call in a provider tool-call turn contains obvious credential material, faithful `argumentsText` is omitted for affected calls, `argumentsRedacted: true` is stored, and the whole turn is marked `nativeReplaySafe: false`. Unsafe turns are not replayed as provider-native assistant/tool protocol messages.

When inspecting tool replay issues, check these fields:

| Surface | What to inspect |
|---------|-----------------|
| Provider tool-call turn | `metadata.kind`, `metadata.nativeReplaySafe`, `metadata.providerToolCalls[].id` |
| Tool result message | `metadata.tool_call_id` |
| Tool planner | generated stable IDs from `stableToolCallId()` |
| Diagnostics | `structured-tool-history-*` session events, counts only |

## Hardening

- Invalid `file.search` regexes are caught before execution.
- Symlink-cycle-safe recursive search.
- Workspace path containment is shared by file and notebook tools.
- `file.glob` and `file.grep` exclude known secret files and generated directories.
- `file.grep` bounds rows, line length, result size, file size, and runtime.
- `notebook.edit` rejects stale edits when `expected_mtime_ms` does not match.
- Portable shell fallback.
- SIGTERM then SIGKILL timeout escalation.
- Stable provider tool-call IDs.
- Basic schema validation before execution.
- Stored-result truncation.
- Native replay never replays a partial multi-call turn.
- Native replay diagnostics never record raw arguments or tool results.
- Delegation child schemas are built after parent intersection and child policy stripping.
- Delegation child approval policy fails closed and does not inherit parent approval grants.

## Tool Plan Dependency Model

`tool-call-planner.ts` currently resolves tool calls linearly. There is no explicit DAG dependency model; add one only with tests that prove ordering, failure propagation, and replay behavior.
