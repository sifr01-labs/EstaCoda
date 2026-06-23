---
title: Tools Reference
description: Tool classes, risk boundaries, availability rules, and failure modes.
sidebar_position: 6
---

# Tools Reference

EstaCoda extends its capabilities through tools. A tool is a typed function that the LLM can request during a turn. The system decides which tools are visible, whether they execute, and what happens when they fail. This page documents the implemented tool surface, not future or registered-only stubs.

---

## What is a tool

A tool has:
- A name (e.g., `file.read`, `web.search`)
- An input schema (OpenAI-compatible JSON Schema)
- A risk class (`safe`, `caution`, `read-only-network`, `external-side-effect`)
- A set of toolsets (e.g., `core`, `web`, `browser`)
- An availability predicate

The runtime registers tools in phases:
1. Pre-skill visibility (built-in, workspace, web, media, voice, vision, cron, memory, config)
2. Post-skill visibility (skill-selected tools)
3. Post-memory provider (knowledge tools)
4. Post-tool executor (delegation, execute_code)

MCP servers are discovered at runtime creation and registered alongside built-in tools.

---

## Tool classes

### Built-in tools

Static tools that are always registered if their provider is loaded.

| Tool | Risk | State touched |
|------|------|---------------|
| `playbook.plan` | `read-only-local` | None |
| `trajectory.record` | `read-only-local` | SQLite (trajectory events) |

### Workspace tools

File-system operations scoped to the workspace and operating under trust boundaries.

| Tool | Risk | State touched |
|------|------|---------------|
| `file.read` | `read-only-local` | None |
| `file.write` | `workspace-write` | Workspace files |
| `file.replace` | `workspace-write` | Workspace files |
| `file.search` | `read-only-local` | None |
| `file.glob` | `read-only-local` | None |
| `file.grep` | `read-only-local` | None |
| `notebook.edit` | `workspace-write` | Workspace notebook files |

**Trust boundary:** Workspace paths are resolved under the active workspace. Traversal outside the workspace and absolute paths outside the workspace are rejected before reads, writes, or spawned searches. `file.write`, `file.replace`, and `notebook.edit` are workspace-write tools and keep the same workspace trust semantics as other local writes. `file.glob` and `file.grep` are read-only local tools.

**Hardening:** Invalid `file.search` regexes are caught before execution. Recursive search remains symlink-cycle-safe. `file.glob` and `file.grep` exclude known secret files and generated directories. `file.grep` bounds rows, line length, total result size, per-file size, and runtime.

#### `file.search`

`file.search` is the simple fallback and compatibility text search tool. Use it for straightforward literal or regex queries when ripgrep-specific behavior is not needed.

Limitations and recovery:

- It does not expose `file.grep` output modes, context, pagination, or ripgrep type filters.
- It is less suitable for large repositories.
- Use `file.grep` for bounded ripgrep-backed content search.
- Use `file.glob` when the goal is to discover files rather than inspect content.

#### `file.glob`

`file.glob` finds workspace files by glob pattern and returns newline-separated workspace-relative paths.

Implementation behavior:

- Primary backend: `rg --files -g <pattern>`.
- Ripgrep respects `.gitignore`.
- Hidden files are excluded by default.
- `include_hidden: true` passes `--hidden`.
- If ripgrep is unavailable, a smaller Node fallback is used.
- The Node fallback supports `*`, `**`, `?`, and basic `{a,b}` groups.
- The Node fallback is intentionally smaller than ripgrep; advanced glob dialect behavior is not promised.

Scope and sorting:

- `path` defaults to `.` and must resolve to a directory inside the workspace.
- Results are workspace-relative.
- Default sorting is lexicographic path sort.
- `sort: "modified"` stats matched files and sorts by descending `mtime`.
- `offset` and `limit` apply after sorting.

Exclusions:

- Secret-ish files are excluded even when hidden files are enabled: `.env`, `.env.*`, `*.pem`, `*.key`, SSH keys such as `id_rsa` and `id_ed25519`, `*.p12`, and `*.pfx`.
- Generated and VCS directories are excluded, including `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`, `node_modules`, `dist`, `build`, `.next`, and `.turbo`.

Failure modes:

- Missing or empty pattern returns an input error.
- A scoped `path` outside the workspace is rejected.
- A scoped `path` that is not a directory is rejected.
- No matches are a successful empty result, not an execution failure.

#### `file.grep`

`file.grep` is the ripgrep-backed content search tool. Use it for large repositories, path-scoped searches, output modes, context, and bounded results. It requires ripgrep. There is no Node content-search fallback.

Implementation behavior:

- Runs `rg` with `cwd` set to the active workspace.
- Passes the scoped target as a workspace-relative path.
- Passes the pattern via `-e <pattern>`.
- `glob` maps to `--glob`.
- `type` maps to `--type`.
- `ignore_case` maps to `-i`.
- `multiline` maps to `-U --multiline-dotall`.
- Binary files are skipped by ripgrep default.
- Hidden files are excluded by default.
- `include_hidden: true` passes `--hidden`.
- Built-in secret and generated-directory exclusions are applied after user glob filters so user input cannot re-include excluded paths.

Output modes:

| Mode | Behavior |
|------|----------|
| `content` | Default. Includes line numbers by default. Context applies only here. |
| `files` | Uses ripgrep file-only matching and returns matching paths. |
| `count` | Returns per-file match counts. |

Limits:

| Input | Default | Behavior |
|------|---------|----------|
| `limit` | `50` | Bounds logical result rows. |
| `offset` | `0` | Skips logical result rows before rendering. |
| `max_result_chars` | `100000` | Caps rendered tool output. |
| `max_line_chars` | `500` | Truncates individual result lines. |
| `max_filesize` | `2M` | Passed to ripgrep as `--max-filesize`. |

Timeout and cancellation:

- Timeout is `30000ms`.
- The spawned `rg` process is killed on timeout.
- If the tool execution signal aborts, the spawned `rg` process is killed.
- Timeout or truncation metadata is returned with a narrowing hint where applicable.

Failure modes and recovery:

- Invalid regex: ripgrep returns an error. Fix the pattern.
- No matches: successful no-match result.
- Missing ripgrep: use `file.search` as the compatibility fallback or install ripgrep.
- Truncated output: narrow `pattern`, `glob`, or `path`; increase `offset`; or use `output_mode: "files"`.
- Secret/generated files missing from results: this is intentional. The exclusions are part of the safety model.

#### `notebook.edit`

`notebook.edit` edits Jupyter notebooks scoped to the active workspace. Prefer workspace-relative `.ipynb` paths in examples and model-facing guidance. It uses the same containment model as `file.read`: paths that resolve outside the workspace, including traversal and absolute paths outside the workspace, are rejected.

Validation:

- Reads the notebook as UTF-8.
- Parses JSON.
- Rejects invalid JSON with a clear error.
- Requires root object, `cells` array, numeric `nbformat`, and numeric `nbformat_minor`.
- Rejects non-`.ipynb` paths.

Edit modes:

| Mode | Required input | Behavior |
|------|----------------|----------|
| `replace` | `cell_id`, `new_source` | Replaces target cell source. |
| `insert` | `new_source` | Inserts at the beginning without `cell_id`; inserts after the target with `cell_id`. |
| `delete` | `cell_id` | Deletes the target cell. |

Cell targeting:

- Real notebook cell IDs are preferred.
- `cell-N` is supported as a zero-based index fallback.
- Invalid `cell_id` is rejected for replace and delete.
- Inserted cells default to `cell_type: "code"` unless `cell_type: "markdown"` is explicitly provided.
- Inserted code cells include minimal valid code-cell fields.
- Inserted markdown cells include minimal valid markdown-cell fields and do not invent code outputs.
- Cell IDs are generated for inserted cells when the notebook format supports them.

Write behavior:

- Unknown notebook-level and cell-level fields are preserved.
- Replacing a code cell resets `execution_count` and `outputs` to `[]`.
- Replacing a markdown cell does not add code outputs.
- `expected_mtime_ms` rejects stale edits when the current mtime differs.
- Writes are atomic: temp file plus rename.
- Result metadata is concise and includes `fileChangePreview`.

Failure modes and recovery:

- Invalid JSON or invalid notebook shape: inspect and repair the file before editing.
- Stale edit: reread the notebook and retry with current metadata.
- Missing cell: use a real cell ID when available or a valid `cell-N` fallback.
- Source formatting: `new_source` is converted to a normal `.ipynb` source field, preserving newline-compatible JSON source representation.

### Web tools

Network read operations. They do not mutate remote state.

| Tool | Risk | State touched |
|------|------|---------------|
| `web.search` | `read-only-network` | None |
| `web.extract` | `read-only-network` | None |
| `web.crawl` | `read-only-network` | None |

**Availability:** Requires an available configured or auto-detected web provider. `web.search` can use Brave Search with a resolved `web.brave.apiKeyEnv` credential, or DDGS when the managed Python capability `ddgs` is installed and verified. `web.extract` can use the guarded `fetch` fallback.

**Failure modes:**
- Missing provider key returns a clear error with the expected env var.
- Missing DDGS capability returns a repair hint for `estacoda python-env setup ddgs`.
- Rate limits surface as tool errors with retry guidance.
- Unsupported provider stubs return unavailable errors.

### Browser tools

Local browser automation via CDP or remote browser backend.

| Tool | Risk | State touched |
|------|------|---------------|
| `browser.*` | `external-side-effect` | Browser session state |

Implemented browser tools include `browser.status`, `browser.navigate`, `browser.snapshot`, `browser.click`, `browser.type`, `browser.scroll`, `browser.press`, `browser.back`, `browser.get_images`, `browser.console`, `browser.cdp`, `browser.screenshot`, `browser.vision`, and `browser.dialog`.

**Availability:** Requires a configured browser backend. `local-cdp` supports manual CDP and supervised auto-launch. Browserbase is implemented through the browser backend and remains blocked until `browser.cloudSpendApproved === true`. browser-use, Firecrawl browser, and Camofox are registered deferred providers.

**Snapshots:** `browser.snapshot` returns compact output by default. Compact output is a bounded actionable AX subset with refs such as `@e1`; it is not true viewport-visible filtering yet. Passing `full: true` requests the larger full snapshot path. Rendered output labels compact vs full snapshots, truncates oversized text, and may summarize large results when `browser.summarizeSnapshots` and `browser.snapshotSummarizeThreshold` allow it.

**Browserbase navigation:** Public HTTP(S) navigation may create a Browserbase session only when Browserbase is configured, `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` are available, and cloud spend is approved. Credentials and config alone do not create sessions. Missing approval returns a spend-gate error and does not fall back to local. Eligible Browserbase failures may fall back to local only when `browser.cloudFallback === true`.

**Hybrid routing metadata:** Where surfaced, browser status or tool metadata can include last backend kind, hybrid routing state, fallback provider/reason, and Browserbase approval/availability status. Secrets and raw Browserbase response bodies are not returned.

**Failure modes:**
- No configured backend returns an unavailable status.
- CDP connection failures surface as execution errors.
- URL safety blocks private/internal URLs unless `security.allowPrivateUrls` is explicitly true.
- Metadata endpoints are hard-blocked in local, cloud, and hybrid routing.
- Unsafe redirects are blanked to `about:blank` when possible; otherwise the unsafe session is closed.

### Media tools

Image generation and vision analysis.

| Tool | Risk | State touched |
|------|------|---------------|
| `image.generate` | `external-side-effect` | Writes image files |
| `vision.analyze` | `safe` | None |

**Availability:** `image.generate` requires a configured image generation provider and API key. `vision.analyze` requires a vision-capable model route.

### Voice tools

Text-to-speech and speech-to-text.

| Tool | Risk | State touched |
|------|------|---------------|
| `voice.speak` | `external-side-effect` | May play audio or write files |
| `voice.transcribe` | `safe` | None |

**Availability:** Hosted TTS providers that require credentials use provider keys. Edge TTS requires no API key, but it is networked and sends synthesis text to Microsoft's Edge speech service. Local STT defaults to managed `faster-whisper` under `~/.estacoda/python-env`, or an explicit command engine. Voice readiness is exposed through CLI status surfaces, not through `isAvailable()` human-readable reasons.

**Implemented providers:**
- TTS: OpenAI, ElevenLabs, MiniMax, Gemini, xAI, Edge
- Hosted STT: OpenAI, Groq, xAI
- Local STT: managed faster-whisper by default, command with explicit `stt.local.engine: "command"`
- Deferred: local/offline TTS providers `neutts` and `kittentts`, Mistral TTS/STT

### Code execution

| Tool | Risk | State touched |
|------|------|---------------|
| `execute_code` | `caution` | None (isolated execution) |
| `python` | `caution` | None (isolated execution) |

**Behavior:** Runs code in a subprocess with timeout escalation (SIGTERM then SIGKILL). Output is truncated before return. Does not write files unless the code itself does.

**Failure modes:**
- Timeout returns a truncated output with a timeout marker.
- Non-zero exit codes surface as tool errors with sanitized stderr.

### Cron tools

| Tool | Risk | State touched |
|------|------|---------------|
| `cronjob` | `caution` | Profile cron store, execution history |

**Actions:** `create`, `list`, `update`, `pause`, `resume`, `run`, `remove`.

**Behavior:** Cron jobs created through the tool use the same storage and validation as CLI cron commands. Prompt safety scanning applies. The tool supports no-agent script jobs, skill labels/instructions, upstream `contextFrom`, model overrides, enabled toolsets, and trusted contained `workdir`. Runtime-backed jobs run in isolated cron runtimes where cron, messaging, and clarify toolsets are forced off. No-agent jobs do not create runtime trajectories.

See [Scheduled Jobs](../user-guide/cron.md) for the full scheduled automation model.

### Memory tools

| Tool | Risk | State touched |
|------|------|---------------|
| `memory.curate` | `workspace-write` | Profile memory files |
| `memory.read` | `read-only-local` | None |
| `memory.search` | `read-only-local` | None |
| `memory.file_compact` | `workspace-write` | Creates compaction backup |
| `memory.file_compaction_restore` | `workspace-write` | Restores from backup |

**Read/search behavior:** `memory.read` and `memory.search` use local lexical memory retrieval. `memory.read` reads bounded local memory by source. `memory.search` searches local memory lexically. Both accept `maxChars`, which is bounded internally. `memory.search` also accepts bounded `maxResults`.

Output is redacted, source-labeled, marked as local memory context, and treated as context rather than instruction. Diagnostics are structured. If the local index is disabled or unavailable, the service falls back to safe substring read/search while preserving protected filtering.

`SOUL.md` is indexed as protected and is excluded by default. Protected entries are returned only when `includeProtected` is explicit, and protected excerpts remain bounded. `AGENTS.md` is not memory and is never indexed as memory.

**Write/compaction behavior:** `memory.curate` writes curated local memory through drift-aware persistence. External disk edits fail closed by default, and diagnostics do not expose raw memory content. `memory.file_compact` compacts `USER.md` or `MEMORY.md`. It supports dry-run, scans generated output before writes, and creates backups. It never targets `SOUL.md` or `AGENTS.md`. Uses the auxiliary `memory_compaction` route.

### Skill tools

| Tool | Risk | State touched |
|------|------|---------------|
| `skill.*` | `safe` | None (read-only inspection) |

**Behavior:** Lists, inspects, and invokes skill playbooks. Skill visibility depends on enabled packs and the current profile.

### Delegation tools

| Tool | Risk | State touched |
|------|------|---------------|
| `delegate_task` | `shared-state-mutation` | Child session rows, delegation events, optional diagnostics, optional outcome memory |
| `terminal.inspect` | `read-only-local` | Bounded command output only |

**Behavior:** Spawns real child agent loops for bounded subtasks. Child sessions are isolated from parent prompt packing, recall, session search, and memory by default. The parent receives a structured result containing child session ID, status, reason, final answer, tool-bound diagnostics, role/depth, timeout/cancelled metadata, stale-file warnings, and provider token usage when available.

Single-task input:

```json
{
  "task": "Inspect the failing test and summarize the likely cause.",
  "context": "Keep the answer short.",
  "allowedTools": ["file.read", "file.grep"],
  "role": "leaf"
}
```

Batch input:

```json
{
  "tasks": [
    { "task": "Inspect config tests." },
    { "task": "Inspect runtime tests." },
    { "task": "Inspect gateway tests.", "context": "Focus on interrupt behavior." }
  ]
}
```

`tasks` may also be a JSON string when JSON-string recovery is enabled. Recovery is strict: each recovered task must be an object with only `task`, `context`, `allowedToolsets`, `allowedTools`, `role`, and `modelOverride`; `context` must be a string when present; unknown fields are rejected.

Default child capability is defined by risk class, not broad toolset names. After parent-visible intersection, children receive `read-only-local` and `read-only-network` tools only, then exact blocked names, blocked prefixes, and excluded toolsets are stripped. Browser, media, and MCP toolsets are excluded by default. Memory/session search, skill mutation, config mutation, cron mutation, trust mutation, credential access, process control, workspace writes, and general shell execution are unavailable by default. `terminal.run` is excluded; `terminal.inspect` is shipped and may be visible to children only through the parent-visible read-only policy.

`leaf` children cannot delegate further. `orchestrator` children can see `delegate_task` only below `maxSpawnDepth`; over-depth requests fail before child session creation.

Child approval policy is non-interactive fail-closed: hardline denies are evaluated first, and anything that would ask for approval or rely on parent approval grants is denied in the child runtime.

Batch delegation is bounded by runtime config (`maxBatchTasks`, `maxConcurrentChildren`) and returns results in input order. Per-child `timeout` and `cancelled` statuses are preserved even when the aggregate batch status is `failed`. Dynamic provider schemas describe the active delegation limits, including spawn depth and batch bounds. `maxDelegateCallsPerTurn` caps multiple separate `delegate_task` tool calls in one provider turn.

Provider token usage is copied from structured provider execution metadata. Batch usage rolls up numeric token fields and reports unavailable usage explicitly. Durable or estimated USD cost accounting is not shipped.

`modelOverride` supports same-provider child model selection and reviewed cross-provider child routes. Cross-provider overrides preserve target provider config, use existing `apiKeyEnv` credentials, respect `authMethod: "none"`, reject `enableNetwork: false` before child execution, and disable fallbacks for the overridden child. Metadata is bounded/redacted.

Outcome memory is disabled by default. When enabled, delegation records bounded task preview and deterministic status/reason summary only, not raw child output, prompts, transcripts, tool arguments, file contents, or diagnostics payloads.

Stale-file warnings are advisory metadata. Parent file reads are snapshotted before delegation; tracked child writes/replaces/deletes to those paths produce warnings without changing delegation status. Shell/process writes are not detected unless represented through the file-state tracker.

**`terminal.inspect`:** Read-only local terminal inspection. Input is `{ "argv": ["git", "status", "--short"] }`. It runs without a shell and allows only `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `file`, `git status`, `git diff`, `git log`, `git branch`, `git remote`, `git ls-files`, and `git grep`. `git show` is not allowed. The tool rejects shell wrappers, pipes, redirection, chaining, command substitution, environment assignment, package scripts, interpreters, arbitrary binaries, mutating commands, unsupported glob arguments, and workspace escapes. Output is bounded and redacted.

Batch execution is capped by `maxBatchTasks` and `maxConcurrentChildren`. Results preserve input order. Per-child `timeout` and `cancelled` statuses are preserved in metadata even when the aggregate batch status is `failed`.

Timeout diagnostics are profile-local, bounded, and redacted. They default to enabled, but full prompt previews are disabled unless explicitly configured.

### Config tools

| Tool | Risk | State touched |
|------|------|---------------|
| `config.compression.status` | `safe` | None |

**Behavior:** Shows normalized compression config, auxiliary route status, and latest session compression state. Does not mutate config or expose credentials.

### Session search tool

| Tool | Risk | State touched |
|------|------|---------------|
| `session_search` | `read-only-local` | None |

**Behavior:** Deterministic raw historical session browse/search/scroll. It uses the local session database through `SessionSearchService`; it is separate from `SessionRecallService`, does not use auxiliary/model summarization, and does not make historical content authoritative.

Modes:

| Mode | Inputs |
|------|--------|
| `browse` | `limit`, `sort` |
| `search` | `query`, `limit`, `sort`, `role_filter` |
| `scroll` | `session_id`, `around_message_id`, `window` |

Output is bounded, redacted, source-labeled, and marked as untrusted historical reference context. Current instructions and runtime policy outrank historical session content. Profile/workspace filtering is applied where available, and active/current session exclusion is used where configured or available.

Limits are internal except for result/message-count knobs. `browse` and `search` default to `10` results and clamp at `20`. `scroll` defaults to `5` messages and clamps at `20`. The schema must not expose `maxChars`; per-message excerpts, session previews, and total tool output are capped internally by the service and fixed registered tool result size.

**Failure modes:** Missing session database, missing sessions, or missing messages return structured diagnostics. Large messages are excerpted before return.

### Knowledge tools

| Tool | Risk | State touched |
|------|------|---------------|
| `knowledge.*` | `safe` | SQLite (knowledge graph) |

**Availability:** Requires workspace root and post-memory provider initialization.

### Process tools

| Tool | Risk | State touched |
|------|------|---------------|
| `process` | `caution` | System processes |

**Behavior:** Lists, polls, logs, waits, kills, and sends input to background processes. Bounded by the host process permissions.

---

## Risk classes

| Class | Meaning | Approval behavior |
|-------|---------|-------------------|
| `safe` | Read-only, local, no side effects | No approval required |
| `caution` | May mutate local state or run code | Prompts in normal mode; auto-approves in open mode unless hard block |
| `read-only-network` | Reads from the network | Prompts in normal mode; auto-approves in open mode unless hard block |
| `external-side-effect` | Mutates external systems or costs money | Always prompts unless explicitly pre-approved |

Hard safety blocks override all modes. A hard block rejects the tool call regardless of YOLO mode or persistent approvals.

---

## Availability boundaries

A tool may be registered but unavailable. The runtime checks `isAvailable()` before offering a tool to the model.

### Provider readiness

Tools that depend on a provider route require the route to be configured. Credential readiness depends on the provider.
- `web.search` requires an available Search provider: Brave needs a credential env reference, while DDGS needs the managed Python capability `ddgs`.
- `image.generate` requires an image generation provider key.
- `voice.speak` requires configured TTS; Edge needs no API key, while credentialed providers need their provider key.
- `voice.transcribe` requires an STT provider, managed local faster-whisper, or an explicit local command.

### Workspace trust

Some tools require workspace trust:
- `file.write` and `file.replace` are gated by trust in strict mode.
- Workspace trust is per-profile and stored in `~/.estacoda/profiles/<id>/trust.json`.

### Security mode

The active security mode (`strict`, `normal`, `open`) changes which tools prompt, which auto-approve, and which are blocked entirely.

### Configured browser backend

Browser tools require a configured backend. Without one, they are registered but unavailable.

### MCP servers

MCP tools are discovered at runtime. If an MCP server is configured but unreachable, its tools are registered and marked unavailable. One-shot CLI commands see current MCP config automatically. Interactive sessions need `/reload-mcp` to refresh after config changes.

### Registered-but-not-implemented stubs

Some providers are catalog-known but not runnable:
- `anthropic`, `minimax`, `nous` are present in metadata but not executable in the current build.
- Unknown custom providers are treated as OpenAI-compatible but require explicit `baseUrl`.

---

## Common failures

### Unavailable tool

The tool is registered but `isAvailable()` returned false. Causes: missing required provider key, missing workspace trust, unconfigured backend, unreachable endpoint, or unreachable MCP server.

**Recovery:** Check `estacoda doctor`, `estacoda settings provider`, or `estacoda mcp status`.

### Approval required

The tool call hit an approval gate. The user must respond with `once`, `session`, `always`, or `deny`.

**Recovery:** Grant approval, switch to a less restrictive security mode, or add a persistent approval for the matching action pattern.

### Denied by hard safety block

The tool call matched a hard safety rule and was rejected regardless of mode or approvals.

**Recovery:** Hard blocks are intentional. The action is unsafe. Reformulate the request or run the operation manually.

### Missing Provider Key

The tool requires an API key or token that is not present in the environment or `.env`. No-auth routes, such as the default Local / private endpoint route, do not require a key; for those routes, check endpoint reachability and `baseUrl` instead.

**Recovery:** Set the expected env var or run `estacoda setup` / `estacoda model setup` for the provider.

### Unsupported provider stub

The provider ID is known in the catalog but has no live implementation.

**Recovery:** Use a live-proven provider. See the provider reference for maturity labels.

---

## Tool execution flow

1. Provider requests a tool call.
2. `ToolCallPlanner` converts the provider call to a `ToolCallPlan`.
3. `ToolExecutor` runs the tool under the active `SecurityPolicy`.
4. The result is packetized and returned to the provider.
5. Stored results are truncated to `maxResultSizeChars`.

---

## Related docs

- [CLI Commands](./cli-commands.md) — commands that inspect and configure tools
- [Slash Commands](./slash-commands.md) — in-session `/tools` and `/reload-mcp`
- [User Guide: Tools](../user-guide/tools.md) — tool concepts and workflows
- [Provider Reference](./provider-reference.md) — provider maturity and setup
