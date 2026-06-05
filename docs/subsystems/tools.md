---
title: "Tools"
description: "Tool system: registry, schemas, execution, and builtin tools."
---

# Tools

Tools are functions that extend the agent's capabilities. They are organized into a registry with risk-based gating.

## Files

| File | Lines | Role |
|------|-------|------|
| `src/tools/tool-registry.ts` | ~220 | Register and resolve tools |
| `src/tools/tool-executor.ts` | ~340 | Execute tool calls |
| `src/tools/tool-call-planner.ts` | 132 | Convert provider calls to plans |
| `src/tools/tool-schema.ts` | ~180 | Build OpenAI-compatible schemas |
| `src/tools/tool-result-packet.ts` | ~120 | Packetize tool results |
| `src/tools/builtin-tools.ts` | ~400 | Built-in tool definitions |
| `src/tools/workspace-tools.ts` | ~580 | File read/write/edit/simple search |
| `src/tools/glob-tools.ts` | ~320 | Workspace file globbing |
| `src/tools/grep-tools.ts` | ~430 | Bounded ripgrep-backed workspace grep |
| `src/tools/notebook-tools.ts` | ~360 | Jupyter notebook cell edits |
| `src/tools/web-tools.ts` | 731 | Web search and extraction |
| `src/tools/execute-code-tool.ts` | ~240 | Code execution |
| `src/tools/vision-tools.ts` | ~200 | Image analysis |
| `src/tools/media-tools.ts` | ~280 | Media handling |

## Builtin Tools

| Tool | Risk | Evidence |
|------|------|----------|
| `file.read` | `safe` | `live-proven` |
| `file.write` | `caution` | `live-proven` |
| `file.replace` | `caution` | `live-proven` |
| `file.search` | `safe` | `smoke-tested` |
| `file.glob` | `read-only-local` | `smoke-tested` |
| `file.grep` | `read-only-local` | `smoke-tested` |
| `notebook.edit` | `workspace-write` | `smoke-tested` |
| `web.search` | `read-only-network` | `smoke-tested` |
| `web.extract` | `read-only-network` | `smoke-tested` |
| `web.crawl` | `read-only-network` | `smoke-tested` |
| `browser.*` | `external-side-effect` | `smoke-tested` |
| `image.generate` | `external-side-effect` | `live-proven` |
| `voice.speak` | `external-side-effect` | `smoke-tested` |
| `voice.transcribe` | `safe` | `smoke-tested` |
| `execute_code` | `caution` | `smoke-tested` |
| `memory` | `safe` | `smoke-tested` |
| `skill.*` | `safe` | `smoke-tested` |
| `cronjob` | `caution` | `smoke-tested` |

## Workspace File Tools

Workspace file tools are scoped to the active workspace. User-provided paths are resolved through the shared containment helper. Traversal outside the workspace is rejected before filesystem mutation or command execution. These tools do not change workspace trust semantics: read-only tools remain read-only local tools, and write tools remain workspace-write tools.

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

- Hosted TTS: OpenAI, ElevenLabs, MiniMax, Gemini, and xAI.
- Hosted STT: OpenAI, Groq, and xAI.
- Local STT: managed faster-whisper by default for `stt.provider: "local"`; command mode only with explicit `stt.local.engine: "command"`.
- Deferred: local TTS providers and Mistral TTS/STT.

Voice credentials are direct environment-variable lookups only. Tool errors use stable provider/reason metadata and bounded sanitized snippets.

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

## Tool Plan Dependency Model

`tool-call-planner.ts` exists but has no DAG. Dependencies are linear. v0.4 target: explicit dependency representation.
