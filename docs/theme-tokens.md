# EstaCoda Theme & Token System

> **Evidence:** `smoke-tested` for token resolution; `eval-tested` for plain/standard parity.

---

## 1. Model Overview

The current UI uses a three-layer token model:

```
Base Theme (light | dark)
    +
Skin Overlay (kemetBlue)
    +
Mode Overlay (plain | standard)
    =
ResolvedTokens
```

| Layer | File | Purpose |
|-------|------|---------|
| **Base Theme** | `src/theme/base-light.ts`, `src/theme/base-dark.ts` | Color palette, surfaces, text, severity, interactive states, semantic motion |
| **Skin Overlay** | `src/theme/kemet-blue-skin.ts` | Brand glyphs, per-motion colors, tool icons, branding text |
| **Mode Overlay** | `src/theme/plain-overlay.ts` | ASCII-safe symbols, disables ANSI/emoji/animation |
| **Resolver** | `src/theme/token-resolver.ts` | Merges layers into `ResolvedTokens` |

---

## 2. Base Themes

### 2.1 Dark Theme (`base-dark.ts`)

| Token | Value | Usage |
|-------|-------|-------|
| `palette.brand` | `#B0B0B0` | Neutral identity fallback |
| `palette.accent` | `#B0B0B0` | Neutral section/accent label fallback |
| `palette.action` | `#B0B0B0` | Neutral selection/action fallback |
| `palette.caution` | `#B0B0B0` | Neutral caution fallback |
| `severity.ok` | `#4CAF50` | Success indicators |
| `severity.error` | `#EF5350` | Errors, failures |
| `severity.warn` | `#FFA726` | Warnings |
| `severity.info` | `#888888` | Info banners |
| `surface.bg` | `#1A1A1A` | Page background |
| `surface.bgElevated` | `#252525` | Elevated panels |
| `surface.border` | `#ededed` | Strong borders |
| `text.primary` | `#E8E8E8` | Main text |
| `text.secondary` | `#B0B0B0` | Secondary text |
| `text.muted` | `#707070` | Dimmed text |
| `interactive.primary` | `#5AACFF` | Primary interactive |
| `interactive.selectedBg` | `#1A3A5C` | Selected item background |

### 2.2 Light Theme (`base-light.ts`)

| Token | Value | Usage |
|-------|-------|-------|
| `palette.brand` | `#666666` | Neutral identity fallback |
| `palette.accent` | `#666666` | Neutral section/accent label fallback |
| `palette.action` | `#666666` | Neutral selection/action fallback |
| `palette.caution` | `#666666` | Neutral caution fallback |
| `severity.ok` | `#2E7D32` | Success |
| `severity.error` | `#C62828` | Errors |
| `severity.warn` | `#EF6C00` | Warnings |
| `severity.info` | `#757575` | Info |
| `surface.bg` | `#FFFFFF` | Page background |
| `surface.bgElevated` | `#F5F5F5` | Elevated panels |
| `surface.border` | `#E0E0E0` | Strong borders |
| `text.primary` | `#1A1A1A` | Main text |
| `text.secondary` | `#4A4A4A` | Secondary text |
| `text.muted` | `#8A8A8A` | Dimmed text |

### 2.3 Design Rules

- **Brand color = identity and live state**, not decoration.
- **Turquoise = selection/action accent**.
- **Amber = rare caution/approval accent**.
- **Violet is reserved for thinking/finalizing motion**, not general decoration.
- **Surfaces stay neutral**, not blue-heavy.
- **Security severity uses semantic tokens**, not brand color.

---

## 3. KemetBlue Skin Overlay

The KemetBlue skin overrides glyphs, branding, tool icons, and selected dark-mode brand colors.

### 3.1 Semantic Motion

Motion is a first-class token category rather than a collection of renderer-owned spinners. Every entry under `contract.motion` owns three independently overridable values: `frames`, `cadenceMs`, and `color`.

| Token | Meaning | Frames | Cadence |
|-------|---------|--------|---------|
| `waiting` | Provider and indeterminate waits | Braille | 85 ms |
| `thinking` | Contemplation and planning | Soft arc | 120 ms |
| `routing` | Intent routing and transitions | Chevron | 95 ms |
| `tool` | Tool execution | Quarter turn | 90 ms |
| `worker` | Delegated workers | Pulse | 105 ms |
| `finalizing` | Response finalization | Diamond | 120 ms |
| `background` | Maintenance and compaction | Orbit | 160 ms |

The KemetBlue light and dark overlays may override the color of any one token without changing its frames or cadence. Renderers read the color from the selected motion definition; they do not substitute `palette.action` or `palette.brand` for animated glyphs.

### 3.2 Tool Icon Overrides

| Tool | Default | KemetBlue |
|------|---------|-----------|
| `terminal` | `$` | `⌘` |
| `webSearch` | `◎` | `◎` |
| `readFile` | `◰` | `◰` |
| `writeFile` | `◆` | `◆` |
| `memory` | `☥` | `☥` |
| `telegram` | `✉` | `✉` |

### 3.3 Branding Overrides

| Field | Default | KemetBlue |
|-------|---------|-----------|
| `agentName` | `EstaCoda` | `EstaCoda` |
| `responseLabel` | `EstaCoda` | `𓂀 EstaCoda` |
| `helpHeader` | `Available Commands` | `𓂀 Available Commands` |
| `taglinePrimary` | (empty) | `⟡ SIFR01 ⟡` |
| `taglineSecondary` | (empty) | `السيادة التكنولوجية العربية` |
| `promptPrefix` | (none) | `𓂀 > ` |

### 3.4 Dark Color Overrides

| Token | KemetBlue Dark Value | KemetBlue Light Value | Usage |
|-------|----------------------|-----------------------|-------|
| `palette.brand` | `#4389D7` | `#4389D7` | Assistant title and brand identity |
| `palette.accent` | `#4C8AE0` | `#0057D9` | Section labels and dashboard accents |
| `palette.action` | `#40E0D0` | `#008C95` | Selection and action accent |
| `palette.caution` | `#FFB454` | `#B45309` | Rare caution/approval accent |

Motion colors are separately defined in `kemet-blue-skin.ts`. Thinking, routing, waiting, tool, worker, finalizing, and background can therefore be tuned independently for each theme.

### 3.5 Assistant Response Progress

Assistant responses can include internal progress metadata below the message body. This metadata is still collected by the runtime, but visible CLI rendering is hidden by default for normal users.

Enable it for development profiles with:

```json
{
  "ui": {
    "showResponseProgress": true
  }
}
```

`showResponseProgress` affects visible CLI rendering only. It does not disable runtime progress collection, provider/tool progress construction, logs, or future diagnostics.

---

## 4. Plain Mode Overlay

The plain overlay is applied **last** and forces ASCII-safe output regardless of base theme or skin.

### 4.1 Symbol Mappings

| Symbol | Standard | Plain |
|--------|----------|-------|
| `prompt` | `›` | `>` |
| `toolPrefix` | `│` | `|` |
| `continuation` | `…` | `...` |
| `bullet` | `•` | `-` |
| `check` | `✓` | `[OK]` |
| `cross` | `✗` | `[X]` |
| `arrow` | `→` | `>>` |
| `motion.waiting.frames` | Braille | `| / - \` |
| `motion.thinking.frames` | Soft arc | `o O o .` |
| `motion.routing.frames` | Chevron | `> >> > .` |
| `motion.tool.frames` | Quarter turn | `| / - \` |
| `motion.worker.frames` | Pulse | `.` |
| `motion.finalizing.frames` | Diamond | `o O o .` |
| `motion.background.frames` | Orbit | `. .. ... ....` |
| `progress.filled` | `█` | `#` |
| `progress.empty` | `░` | `-` |
| `progress.thumb` | `▌` | `>` |

### 4.2 Tool Icon Mappings (Plain)

| Tool | Standard | Plain |
|------|----------|-------|
| `terminal` | `$` / `⌘` | `$` |
| `webSearch` | `◎` | `?` |
| `readFile` | `◰` | `R` |
| `writeFile` | `◆` | `W` |
| `searchFiles` | `◇` | `F` |
| `executeCode` | `⌬` | `X` |
| `browserNavigate` | `☞` | `B` |
| `delegateTask` | `☷` | `D` |
| `memory` | `☥` | `~` |
| `clarify` | `?` | `?` |
| `cronjob` | `◷` | `C` |
| `process` | `⌁` | `P` |
| `todo` | `□` | `T` |
| `telegram` | `✉` | `@` |
| `media` | `◉` | `*` |

### 4.3 Behavior Overrides

```
allowEmoji: false
allowAnimation: false
allowAnsiColor: false
```

---

## 5. Token Resolution

### 5.1 API

```typescript
import { resolveTokens } from "./theme/token-resolver.js";

const tokens = resolveTokens(mode, theme, skin);
// mode: "plain" | "standard"
// theme: "light" | "dark"
// skin: "kemetBlue"
```

### 5.2 Merge Strategy

1. Start with base theme (`light` or `dark`).
2. Deep-merge `kemetBlueSkin` overlay.
3. If `mode === "plain"`, deep-merge `plainOverlay`.

The merge is **deep** for nested objects (`motion`, `glyph`, `progress`, `toolIcon`, `branding`, `behavior`). A skin can override only `motion.tool.color`, for example, while retaining the base frames and cadence.

### 5.3 ResolvedTokens Shape

```typescript
interface ResolvedTokens {
  readonly mode: UiMode;
  readonly theme: UiTheme;
  readonly skin: SkinName;
  readonly contract: UiTokenContract;
}
```

---

## 6. ANSI Mappings

### 6.1 True Color (24-bit)

When `supportsTrueColor === true`:

```
Foreground: \x1b[38;2;R;G;Bm<text>\x1b[0m
Background: \x1b[48;2;R;G;Bm<text>\x1b[0m
```

### 6.2 ANSI 256

When `supportsColor === true` but `supportsTrueColor === false`:

```
Foreground: \x1b[38;5;Nm<text>\x1b[0m
Background: \x1b[48;5;Nm<text>\x1b[0m
```

Where `N` is computed via `hexToAnsi256()` using the 6x6x6 RGB cube or grayscale ramp.

### 6.3 Plain Mode

All ANSI helpers return the raw text unchanged:

```typescript
#color(text, hex) → text
#bold(text) → text
#dim(text) → text
```

---

## 7. Extending the Token System

### 7.1 Adding a New Skin

1. Create `src/theme/my-skin.ts` exporting a `TokenOverlay`.
2. Import it in `src/theme/token-resolver.ts`.
3. Add the skin name to the `SkinName` union in `src/contracts/ui-tokens.ts`.
4. Apply the overlay in `resolveTokens()` when the skin matches.

### 7.2 Adding a New Token Category

1. Add the field to `UiTokenContract` in `src/contracts/ui-tokens.ts`.
2. Add a default value to `base-light.ts` and `base-dark.ts`.
3. Add plain-safe fallback to `plain-overlay.ts`.
4. Consume it in `StandardRenderer`.

### 7.3 Customizing One Motion

Use a theme-aware skin overlay:

```typescript
const skin = {
  shared: {},
  dark: {
    motion: {
      tool: { color: "#40E0D0", cadenceMs: 90 },
    },
  },
  light: {
    motion: {
      tool: { color: "#008C95" },
    },
  },
};
```

Do not add a timer with a motion override. The live console owns one animation clock and derives frames from elapsed time and each token's cadence.

---

## 8. Environment Variables

| Variable | Effect |
|----------|--------|
| `NO_COLOR` | Disables all ANSI color |
| `FORCE_COLOR=0` | Disables color |
| `FORCE_COLOR=1` | Enables basic color |
| `FORCE_COLOR=3` | Enables true color |
| `TERM=dumb` | Disables color and animation |
| `COLUMNS` | Overrides terminal width |
| `NO_EMOJI` | Disables emoji |
| `ESTACODA_NO_EMOJI` | Disables emoji (EstaCoda-specific) |
| `ESTACODA_THEME` | Sets theme (`light` or `dark`) |
| `ESTACODA_MODE` | Sets mode (`plain` or `standard`) |
| `ESTACODA_SKIN` | Sets skin (`kemetBlue`) |
