# EstaCoda UI Architecture

> **Evidence:** `live-proven` for core pipeline; `smoke-tested` for runtime integration.

---

## 1. Pipeline Overview

All CLI and channel output flows through a three-stage pipeline:

```
Runtime / Command Data → ViewModel → Renderer → Surface Adapter → Output
```

| Stage | Responsibility | Key Files |
|-------|---------------|-----------|
| **ViewModel** | Pure structured data. No formatting, ANSI, or terminal logic. | `src/contracts/view-model.ts`, `src/ui/view-models/builders.ts` |
| **Renderer** | Converts ViewModels to strings. Handles ANSI, Unicode, layout, width. | `src/ui/renderers/plain-renderer.ts`, `src/ui/renderers/standard-renderer.ts` |
| **Surface Adapter** | Channel-safe output formatter. Strips/transforms for Telegram, Discord, Email, etc. | `src/contracts/surface-adapter.ts`, `src/channels/surface-adapters/*.ts` |

---

## 2. ViewModel Layer

### 2.1 Design Principle

ViewModels are **pure data objects** with a discriminated `kind` field. They contain no ANSI codes, no emoji, no width calculations, and no rendering logic. A builder function accepts runtime data and returns a ViewModel.

### 2.2 ViewModel Types

| `kind` | Purpose | Builder |
|--------|---------|---------|
| `status` | Runtime status (`/status`, `/model`) | `buildStatusViewModel` |
| `table` | Tabular data (cron list, channels list) | `buildTableViewModel` |
| `kv` | Key-value blocks (settings, model info) | `buildKeyValueBlockViewModel` |
| `list` | Ordered/unordered lists (`/help`, `/tools`) | `buildListViewModel` |
| `warning` | Warnings, errors, info banners | `buildWarningErrorViewModel` |
| `approval` | Framed approval/security prompts | `buildApprovalSecurityViewModel` |
| `timeline` | Tool activity timeline | `buildActivityTimelineViewModel` |
| `progress` | Status rail with session/task timers | `buildProgressContextRailViewModel` |
| `picker` | Interactive selection lists | `buildPickerViewModel` |
| `startup` | Startup hero screen | `buildStartupViewModel` |
| `commandResult` | Command success/failure with nested blocks | `buildCommandResultViewModel` |
| `plainFallback` | Escape hatch for legacy string output | `buildPlainFallbackViewModel` |
| `assistantResponse` | Assistant message with framed header | `buildAssistantResponseViewModel` |

### 2.3 Builder Rules

- Builders live in `src/ui/view-models/builders.ts`.
- They accept plain input interfaces and return frozen-shaped objects.
- No string formatting (`.padEnd`, `.toUpperCase`, template literals) in builders.
- Severity values use the `ViewModelSeverity` union: `"ok" | "warn" | "error" | "info"`.

---

## 3. Renderer Layer

### 3.1 Two Renderers

| Renderer | Mode | ANSI | Unicode | Emoji | Animation |
|----------|------|------|---------|-------|-----------|
| `PlainRenderer` | `plain` | No | No | No | No |
| `StandardRenderer` | `standard` | Yes | Yes | Skin-controlled | Capability-gated |

Both implement the same implicit contract: `render(viewModel: ViewModel): string`.

### 3.2 Renderer Selection

`createSessionRenderer()` in `src/cli/session-renderer.ts` selects the renderer based on terminal capabilities:

```
plain mode is chosen when ANY of:
  - explicit --plain flag
  - !isTTY
  - isCI
  - isDumb
  - !supportsColor

standard mode is chosen when ALL of:
  - isTTY
  - supportsColor
  - !isCI
  - !isDumb
```

### 3.3 Plain Renderer

- Lives in `src/ui/renderers/plain-renderer.ts`.
- Exports `renderPlain(viewModel): string`.
- Uses ASCII-only markers: `[ ]`, `[>]`, `[x]`, `[-]`, `[?]` for timeline/progress.
- Uses ASCII severity tags: `[WARN]`, `[ERROR]`, `[INFO]`, `[OK]`, `[FAIL]`.
- Tool timeline uses semantic text labels, never emoji.
- Assistant response label falls back to `"EstaCoda"` if the original label contains non-ASCII characters.

### 3.4 Standard Renderer

- Lives in `src/ui/renderers/standard-renderer.ts`.
- Class-based: `new StandardRenderer({ tokens, capabilities })`.
- Reads `ResolvedTokens` for colors and glyphs.
- Uses true-color ANSI (`38;2;R;G;B`) when `supportsTrueColor`, otherwise ANSI 256.
- Uses Unicode box-drawing for framed panels (`┌─┐│└─┘`, `╭─╮│╰─╯`).
- Falls back to ASCII `+|-` when `!supportsUnicode`.
- Timeline markers use `○`, `✓`, `✗`, `⚠` with semantic motion for `running`.
- Motion definitions are read from `tokens.contract.motion`; every token owns frames, cadence, and color.
- Animation is **never** started when `!capabilities.supportsAnimation`.

### 3.5 Layout Utilities

`src/ui/renderers/layout.ts` provides:

- `measureTextWidth(text)` — Unicode-aware width (counts CJK/emoji as 2, combining chars as 0).
- `wrapText(text, maxWidth)` — word-wrap with width awareness.
- `truncateText(text, maxWidth, ellipsis?)` — safe truncation.

---

## 4. Surface Adapter Layer

### 4.1 Contract

`SurfaceAdapter` (in `src/contracts/surface-adapter.ts`) defines:

```typescript
interface SurfaceAdapter {
  readonly kind: SurfaceKind;
  readonly capabilities: SurfaceCapabilities;
  render(viewModel: ViewModel): string;
  renderToolActivity(event): string;
  renderProgressLabel(event): string;
  renderAssistantResponse(label, text, options?): string;
}
```

### 4.2 Implemented Adapters

| Adapter | `kind` | Emoji | ANSI | HTML | Markdown |
|---------|--------|-------|------|------|----------|
| `PlainLogSurfaceAdapter` | `plain-log` | No | No | No | No |
| `TelegramSurfaceAdapter` | `telegram` | Yes | No | Yes | No |
| `DiscordSurfaceAdapter` | `discord` | Yes | No | No | Yes |
| `EmailSurfaceAdapter` | `email` | No | No | No | Yes |
| `WhatsAppSurfaceAdapter` | `whatsapp` | No | No | No | No |

All ViewModel rendering delegates to `renderPlain()` today. Channel-specific formatting for tool activity and assistant responses is handled by dedicated helper modules.

### 4.3 Channel-Safe Rendering

Channel adapters must never emit ANSI escape codes. The `PlainLogSurfaceAdapter` is the reference implementation for channel-safe output:

- Delegates to `renderPlain()` for all ViewModels.
- Uses `ChannelToolActivityRenderer` for tool events (semantic text only).
- Uses `renderChannelAssistantResponse()` for assistant messages (ASCII-safe label).

---

## 5. Terminal Capability Detection

### 5.1 Detected Capabilities

`detectTerminalCapabilities()` in `src/ui/terminal-capabilities.ts` checks:

| Capability | Source |
|------------|--------|
| `isTTY` | `stream.isTTY` |
| `supportsColor` | `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, `isTTY`, `COLORTERM` |
| `supportsTrueColor` | `COLORTERM=truecolor\|24bit` |
| `supportsUnicode` | `LC_ALL`, `LANG`, `platform`, `WT_SESSION`, `TERM_PROGRAM` |
| `supportsEmoji` | `supportsUnicode` minus `NO_EMOJI` / `ESTACODA_NO_EMOJI` |
| `terminalWidth` | `stream.columns`, `COLUMNS` env (default 80) |
| `isDumb` | `TERM=dumb` |
| `isCI` | `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, etc. |
| `supportsAnimation` | `isTTY && !isDumb && !isCI && supportsColor` |

### 5.2 Fallback Rules

```
NO_COLOR=1        → supportsColor=false, supportsAnimation=false
FORCE_COLOR=0     → supportsColor=false
TERM=dumb         → supportsColor=false, supportsAnimation=false
non-TTY           → supportsAnimation=false
CI environment    → supportsAnimation=false
```

---

## 6. Papyrus And Operator Console Ownership

### 6.1 Idle Prompt Ownership

Papyrus is the terminal UI substrate. The Operator Console is the live
interactive CLI frame built on Papyrus and enabled by default for production
interactive TTY launches. The raw prompt tracks editable text and key semantics,
then maps prompt, slash, attachment, and status state into the Operator Console.
Gateway, one-shot, non-TTY, and non-CLI channel input do not use this
interactive prompt path.

Secret prompts are a hard boundary. They may accept pasted bytes as input, but they must not publish paste preview callbacks, paste reference files, live slash hints, or temporary chrome containing secret text.

### 6.2 Operator Console Region

The Operator Console owns the cursor-managed live TTY region around interactive
input. The transcript area owns durable user rails and assistant cards. The
Operator Console region is composed from semantic surfaces in this order:

```text
startup/transcript
approvals, if present
active work, if present
queued steer, if present
attachments, if present
prompt / steer input
slash menu, if present
status rail
setup/select panels where applicable
```

The persistent status rail contains only model, context usage/bar, and session
timer. Tools, approvals, workspace/trust, setup, steering, channel state, and
active-turn noise belong in contextual surfaces and must not be smuggled into
the rail.

The context bar uses only the active session's last provider-reported input
token count. It holds that value across turns and usage-less responses and
shows `--/total` before the first measurement or after compaction/model changes.
Live and assembled-prompt estimates are not rail state.

Do not manually combine removed transient-region calls with Papyrus prompt
rendering. The raw prompt render loop is only a terminal diff/write/cursor
cleanup adapter; it does not build prompt/status/slash/attachment frames.

### 6.3 Active-Turn Steering And Work

After submit, the idle prompt no longer owns the cursor. Active-turn surfaces
show active work, approvals, queued steer, and the steer input surface. Tool
activity maps into the uncapped Operator Console active-work model and rendering
is viewport-limited. Active-turn surfaces must not recreate a read-only prompt
box containing the submitted user text.

The active-turn input lane is Operator Console-owned in interactive TTY sessions. Normal typed text opens the `Steer current turn` surface, and non-empty submitted steer text aborts the current turn with `CLI steer` before scheduling one CLI-layer retry with an explicit steering note. `Ctrl+C` remains the hard interrupt path and is not modeled as steer submission or cancellation. Steering is not a runtime/provider in-flight steering primitive.

---

## 7. Command Registry

### 7.1 Role

The command registry (`src/cli/command-registry.ts`) is the **single source of truth** for:

- Command names and aliases
- Categories and descriptions
- Visibility (`public` | `hidden` | `debug`)
- Scope (`cli` | `slash` | `both`)
- Parent/child relationships for subcommands

### 7.2 Rules

- `/help`, autocomplete, startup hints, and slash menus all read from the registry.
- No hardcoded command lists exist outside the registry.
- New commands must be registered at module load time.
- The registry supports filtering by scope, visibility, and parent.

---

## 8. Provider-Token Streaming Safety

### 8.1 Constraint

Provider tokens are streamed via `output.write(event.text)` directly. The animation and status rail must never:

1. Write ANSI cursor manipulation codes (clear line, move up) during token streaming.
2. Overwrite the same terminal line as token output.
3. Start or update spinners on the token line.

### 8.2 Enforcement

- `AnimationController` only runs in interactive TTY standard mode.
- Status rail and activity timeline write on dedicated lines above the token stream.
- The animation controller tracks "streaming zone" vs "status zone" implicitly by never sharing output streams.

---

## 9. Input Rail-Frame Behavior

### 9.1 Design

The input rail-frame is a **thin horizontal rule** that separates turns, not a full box:

- Standard mode: Unicode horizontal rule (`─` repeated to width) with optional brand color.
- Plain mode: ASCII dash (`-`) repeated to width.
- Narrow width: truncated to `terminalWidth`.

### 9.2 Prompt Prefix

- KemetBlue skin + standard mode: `𓂀 > `
- Plain mode: `> `
- Configurable via `tokens.contract.branding.promptPrefix`.

---

## 10. Status Rail Timers

The `ProgressContextRailViewModel` includes two timer fields:

- `sessionElapsedMs` — time since session start.
- `taskElapsedMs` — time since current task started, or `"idle"`.

Rendered as:
- Standard mode: `◷ 12.3s  ⧖ 4.5s` (Unicode glyphs + duration).
- Plain mode: `sess 12.3s  task 4.5s` (ASCII labels).

---

## 11. Assistant Response Framing

### 11.1 Standard Mode

Assistant responses render with a framed header:

```
╭──────────────────────────
│ 𓂀 EstaCoda
│ Here is the response...
╰──────────────────────────
```

### 11.2 Plain / Channel Mode

```
EstaCoda:
Here is the response...
```

The label `"𓂀 EstaCoda"` is skin-configurable. Plain mode falls back to `"EstaCoda"` automatically.

---

## 12. Startup Hero and Picker

### 12.1 Startup

Interactive terminal launch renders `StartupDashboardViewModel` by default. It combines the compact startup identity with readiness data:
- Standard mode: Hero panel, version/session separator, model readiness, workspace/security fields, and interactive command hints.
- Plain mode: Simple text block with version, session, model readiness, workspace/security fields, and interactive command hints.

`StartupViewModel` is the legacy compact startup hero and fallback when readiness collection cannot complete. It renders as:
- Standard mode: Hero panel with brand-colored agent name, dim taglines, readiness state, and warnings.
- Plain mode: Simple text block with agent name, taglines, model, readiness.

### 12.2 Picker

`PickerViewModel` renders as a numbered list:
- TTY standard mode: ANSI-colored selection indicator (`>`) with highlighted label.
- Non-TTY / plain mode: numbered list with no cursor controls.

The interactive picker in `src/cli/interactive-select.ts` gates ANSI cursor controls on `capabilities.isTTY`.

---

## 13. Compatibility Wrappers

The current UI preserves backward-compatible string-returning functions:

| Legacy Function | What It Does Today |
|-----------------|-------------------|
| `runtime.describe()` | Returns `string`. Internally may use ViewModel + PlainRenderer, but signature is unchanged. |
| `renderSlashMenu()` | Returns `string`. Builds `ListViewModel` from registry + renders. |
| `renderToolsMenu()` | Returns `string`. Builds `TableViewModel` from registry + renders. |
| CLI command handlers | Still return `{ output: string }`. Internally use ViewModels where migrated. |

All existing tests pass without modification.

---

## 14. How to Add a New CLI Surface

See `docs/rendering-guide.md` for the contributor walkthrough.
