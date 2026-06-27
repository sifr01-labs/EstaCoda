# Rendering Guide for Contributors

> **Target audience:** Engineers adding new CLI surfaces, commands, or output formats to EstaCoda.

---

## 1. Golden Rule

**Never build output strings directly from runtime data.**

Always follow the pipeline:

```
Runtime Data → ViewModel Builder → Renderer → Output
```

---

## 2. Step-by-Step: Adding a New CLI Surface

### Step 1: Define the ViewModel Type (if new)

If the existing ViewModel types in `src/contracts/view-model.ts` do not cover your surface, add a new `kind`:

```typescript
export interface MyNewViewModel {
  readonly kind: "myNew";
  readonly title: string;
  readonly items: readonly { label: string; value: string }[];
}
```

Add it to the `ViewModel` discriminated union at the bottom of the file.

> **Prefer reusing existing types.** Most surfaces fit into `table`, `kv`, `list`, `warning`, or `commandResult`.

### Step 2: Write the Builder

In `src/ui/view-models/builders.ts`, add a builder function:

```typescript
export interface BuildMyNewInput {
  readonly title: string;
  readonly items: readonly { label: string; value: string }[];
}

export function buildMyNewViewModel(input: BuildMyNewInput): MyNewViewModel {
  return {
    kind: "myNew",
    title: input.title,
    items: input.items,
  };
}
```

Builders must be **pure** — no formatting, no ANSI, no width calculations.

### Step 3: Add Renderer Support

#### Plain Renderer

In `src/ui/renderers/plain-renderer.ts`, add a case to `renderPlain()`:

```typescript
case "myNew":
  return renderMyNew(viewModel);
```

Implement the plain render function:

```typescript
export function renderMyNew(vm: MyNewViewModel): string {
  const lines = [vm.title, ""];
  for (const item of vm.items) {
    lines.push(`- ${item.label}: ${item.value}`);
  }
  return lines.join("\n");
}
```

Rules for plain rendering:
- Use ASCII only.
- No ANSI escape codes.
- No emoji.
- No box-drawing characters.

#### Standard Renderer

In `src/ui/renderers/standard-renderer.ts`, add a case to `render()`:

```typescript
case "myNew":
  return this.renderMyNew(vm);
```

Implement the standard render method:

```typescript
renderMyNew(vm: MyNewViewModel): string {
  const lines = [this.#bold(vm.title), ""];
  for (const item of vm.items) {
    lines.push(`${this.#glyph("bullet")} ${item.label}: ${this.#dim(item.value)}`);
  }
  return lines.join("\n");
}
```

Rules for standard rendering:
- Use `#color()`, `#bold()`, `#dim()` for ANSI styling.
- Use `#glyph()` for Unicode symbols with automatic ASCII fallback.
- Respect `this.#capabilities.terminalWidth` for wrapping.
- Use `measureTextWidth()` from `layout.ts` for width-aware operations.

Small CLI-only notices may use a localized helper instead of a full ViewModel when the surface is intentionally narrow. The helper must still be capability-gated: interactive TTY-capable standard output may bold stable notice labels, while plain, CI, non-TTY, and no-capability paths must emit unstyled text with no ANSI escapes. `/model` session override notices follow this rule; the notice is compact and must not replay startup dashboard/runtime status text.

### Step 4: Add Snapshot Tests

Create or extend a test file (e.g., `src/cli/my-surface.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import { buildMyNewViewModel } from "../ui/view-models/builders.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { StandardRenderer } from "../ui/renderers/standard-renderer.js";
import { resolveTokens } from "../theme/token-resolver.js";

function fullCaps() {
  return {
    isTTY: true, supportsColor: true, supportsTrueColor: true,
    supportsUnicode: true, supportsEmoji: true, terminalWidth: 80,
    isDumb: false, isCI: false, supportsAnimation: true,
  };
}

function plainCaps() {
  return {
    isTTY: false, supportsColor: false, supportsTrueColor: false,
    supportsUnicode: false, supportsEmoji: false, terminalWidth: 80,
    isDumb: true, isCI: false, supportsAnimation: false,
  };
}

const vm = buildMyNewViewModel({
  title: "My Surface",
  items: [{ label: "foo", value: "bar" }],
});

describe("myNew surface", () => {
  it("renders plain", () => {
    const output = renderPlain(vm);
    expect(output).not.toMatch(/\x1b\[/);
    expect(output).toMatchSnapshot("myNew-plain");
  });

  it("renders standard dark", () => {
    const renderer = new StandardRenderer({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities: fullCaps(),
    });
    const output = renderer.render(vm);
    expect(output).toMatchSnapshot("myNew-standard-dark");
  });

  it("renders standard light", () => {
    const renderer = new StandardRenderer({
      tokens: resolveTokens("standard", "light", "kemetBlue"),
      capabilities: fullCaps(),
    });
    const output = renderer.render(vm);
    expect(output).toMatchSnapshot("myNew-standard-light");
  });

  it("renders no-Unicode", () => {
    const renderer = new StandardRenderer({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities: { ...fullCaps(), supportsUnicode: false, supportsEmoji: false },
    });
    const output = renderer.render(vm);
    expect(output).not.toMatch(/[\u2500-\u257f]/); // no box drawing
    expect(output).toMatchSnapshot("myNew-no-unicode");
  });

  it("renders narrow width", () => {
    const renderer = new StandardRenderer({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities: { ...fullCaps(), terminalWidth: 40 },
    });
    const output = renderer.render(vm);
    expect(output).toMatchSnapshot("myNew-narrow");
  });
});
```

### Step 5: Wire Into the CLI

If your surface is a new command, register it in `src/cli/command-registry.ts`:

```typescript
commandRegistry.register({
  name: "mycommand",
  aliases: [],
  category: "Tools",
  description: "Does the new thing",
  visibility: "public",
  scope: "both",
});
```

In your command handler, build the ViewModel and render it:

```typescript
import { buildMyNewViewModel } from "../ui/view-models/builders.js";
import { createSessionRenderer } from "./session-renderer.js";

export function handleMyCommand(runtime, args) {
  const vm = buildMyNewViewModel({
    title: "Results",
    items: computeItems(runtime, args),
  });

  const renderer = createSessionRenderer({ output: process.stdout });
  const output = renderer.render(vm);

  return { ok: true, output };
}
```

### Step 6: Run Tests

```bash
pnpm run test
pnpm run typecheck
```

Update snapshots if needed:

```bash
pnpm run test -- --update
```

---

## 3. Papyrus-Owned Interactive Surfaces

Papyrus is the terminal UI substrate for live interactive CLI sessions. The
Operator Console is the live frame built on Papyrus. Core sessions,
setup/operator prompts, slash autocomplete, approval cards, active-turn steer
input, paste attachments, startup, and setup/select panels must route through
the Operator Console or Papyrus prompt/surface controllers rather than ad hoc
terminal writes.

The prompt row is not a free output line. The Papyrus raw prompt and surface
controllers own cursor movement, managed regions, slash surfaces, paste
reference rows, active status chrome, and cleanup on submit/cancel/error.

Operational rules:

- Do not reintroduce direct terminal input ownership outside the Papyrus raw
  prompt/key paths.
- Do not mix removed transient/chrome row calls into Papyrus-managed prompt
  regions.
- Account for managed-region line-count growth and shrink.
- Show shortcut hints only while the editable line is empty; hide them on non-empty input and let slash hints take priority for `/`.
- Clear stale managed lines when prompt, slash, attachment, approval, active
  work, or steer surfaces disappear.
- Treat terminal width as mutable; prompt wrapping can change while the user is editing.
- Never mirror secret prompt content into attachment previews, status rails,
  logs, or debug chrome.
- Keep active-turn steering in the Operator Console steer surface. Do not write
  steer buffers directly to the terminal.
- Do not reintroduce a fake prompt box after submit. The submitted user text
  belongs in transcript/history rendering; active-turn UI is semantic console
  state.
- Arabic setup chrome is direction-aware for setup selectors, rails, and onboarding summaries. Raw setup string prompts are still a follow-up RTL surface; do not claim full runtime Arabic localization.

Cursor-control changes need real terminal smoke in addition to unit tests. Tests can prove line accounting for known streams; a real terminal catches emulator behavior around cursor save/restore, wrapping, scrollback, and bracketed paste mode.

Setup prompt cards are direction-aware. Arabic prompt cards and selectors should keep technical tokens such as env vars, slash commands, provider IDs, model IDs, bot handles, and file paths isolated in LTR spans or code-style runs. When truncating or padding mixed Arabic/English text, preserve balanced bidi isolates and measure visible width, not raw string length.

---

## 4. Common Patterns

### 4.1 Command Result with Nested Blocks

Use `CommandResultViewModel` to wrap multiple ViewModels:

```typescript
const vm = buildCommandResultViewModel({
  ok: true,
  title: "Gateway status",
  blocks: [
    buildTableViewModel({ ... }),
    buildWarningErrorViewModel({ ... }),
  ],
});
```

### 4.2 Table with Empty State

```typescript
buildTableViewModel({
  title: "Cron jobs",
  columns: [{ key: "id", header: "ID" }, { key: "name", header: "Name" }],
  rows: jobs.map(j => ({ id: j.id, name: j.name })),
  emptyMessage: "No cron jobs configured.",
});
```

### 4.3 Warning Banner

```typescript
buildWarningErrorViewModel({
  severity: "warn",
  title: "Missing config",
  message: "Telegram token is not set.",
  details: ["Set TELEGRAM_BOT_TOKEN in your environment."],
});
```

### 4.4 Approval Prompt

```typescript
buildApprovalSecurityViewModel({
  toolName: "workspace.write",
  riskClass: "destructive-local",
  targetSummary: "src/index.ts",
  severity: "warn",
  actions: [
    approvalAction("once", "Allow once"),
    approvalAction("session", "Allow for this session"),
    approvalAction("always", "Always allow", "warn"),
    approvalAction("deny", "Deny", "error"),
  ],
});
```

---

## 5. What NOT to Do

| Anti-pattern | Correct Approach |
|--------------|----------------|
| `lines.push(`[31mError[0m`)` | Return a `WarningErrorViewModel`, let the renderer apply severity color. |
| `if (isTTY) output.write(cursorHide)` | Gate on `capabilities.supportsAnimation`, use `AnimationController`. |
| `const icon = isEmoji ? `💎` : `*` | Define the icon in the skin token `toolIcon`, let the renderer pick based on capabilities. |
| `output.write(`┌${`─`.repeat(w)}┐`)` | Use `#framedPanel()` in `StandardRenderer` or plain text blocks in `PlainRenderer`. |
| `const lines = ["header", `  ${key}: ${value}`]` | Build a `KeyValueBlockViewModel` and render it. |
| Hardcoding command names in `/help` | Register commands in `CommandRegistry`, read from registry. |
| Writing terminal output into the live prompt region | Route through the Papyrus raw prompt, surface controller, or Operator Console host. |
| Mirroring secret prompt input into preview/status chrome | Keep secret prompt content inside the prompt answer path only. |
| Rendering tool activity with fixed live slots or timers | Route tool-start/tool-result rows through the Operator Console active-work surface, with durable/plain fallbacks outside TTY console rendering. |
| Putting a prompt marker inside placeholder copy | Let the prompt row own `>`/`›`; placeholder copy starts with the hint text. |

---

## 6. Operator Console Region Stability

The CLI renderer treats terminal regions as exclusive ownership zones:

```text
Transcript area:
  durable user rails
  durable assistant cards
  durable tool activity rows

Operator Console region:
  active work, if present
  approvals, if present
  queued steer, if present
  attachments, if present
  prompt / steer input
  slash menu, if present
  status rail
```

The transcript area is append-oriented. The Operator Console region is
cursor-managed and composed from `OperatorConsoleState`. Its persistent status
rail contains only model, context usage/bar, and session timer. Tools,
approvals, workspace/trust, setup, steering, channel state, and active-turn
noise belong in contextual surfaces, not in the rail.

Idle placeholder copy is not a separate shortcut rail and must not include a
prompt marker. The slash menu is an Operator Console region below the prompt and
above the status rail. Arabic console surfaces must measure visible width, keep
technical tokens LTR-isolated, and preserve balanced bidi isolates after
truncation or padding.

---

## Papyrus Full Interactive Migration

Papyrus is now the interactive CLI architecture for live TTY use:

- Core interactive TTY sessions use the Operator Console by default.
- Core TTY prompts use raw Papyrus input.
- Slash autocomplete renders as the Operator Console slash menu.
- Promptable approvals render as Papyrus approval cards.
- Setup/operator prompts route through the Papyrus-capable prompt factory.
- Shared interactive menus use Papyrus select widgets.
- Active-turn steering uses Operator Console steer state; `Ctrl+C` remains hard
  interrupt.

Non-TTY one-shot and pipe-driven sessions remain plain and deterministic. They
do not activate raw prompt behavior or cursor-managed console regions.

The migrated prompt surfaces include:

- `estacoda setup`, `estacoda setup --interactive`, and
  `estacoda setup --advanced`.
- First-run onboarding.
- Setup Editor and config editor prompts.
- Model setup prompts, including Codex model setup.
- Secret/API-key prompts.
- Voice setup confirmations.
- Image setup secret prompts.
- Telegram setup prompts.
- WhatsApp wizard prompts.
- Pack install/enable prompts.
- Python environment setup/reset prompts.
- Shared interactive select menus.

Secret prompts stay no-echo, do not expose paste previews, and must not mirror
secret input into logs, status rail text, or prompt callbacks.

`ESTACODA_UI_RENDERER=legacy` and `ESTACODA_INPUT_MODE=readline` no longer
activate legacy interactive modes. Non-interactive command paths remain plain and
deterministic.

Removed renderer/input rollout flags are ignored deterministically:

| Flag | Effect |
|------|--------|
| `ESTACODA_UI_RENDERER=legacy` | Ignored; live interactive sessions still use Papyrus rendering. |
| `ESTACODA_INPUT_MODE=readline` | Ignored for interactive sessions; raw Papyrus input remains active. |

Optional Papyrus capabilities remain opt-in. They are not enabled by the default
renderer/input rollout:

| Capability | Opt-in flag |
|------------|-------------|
| Vim keymap | `ESTACODA_INPUT_KEYMAP=vim` |
| shell-history suggestions | `ESTACODA_SHELL_HISTORY=1` |
| clipboard reads | `ESTACODA_CLIPBOARD=1` |
| MCP resource suggestions | `ESTACODA_MCP_SUGGESTIONS=1` |
| skill suggestions | `ESTACODA_SKILL_SUGGESTIONS=1` |
| Slack suggestions | no default Slack suggestion provider is enabled |

`/status` reports these optional Papyrus capability states so operators can
confirm whether a session is using only the default rollout surface or additional
explicitly enabled helpers.

---

## 7. Renderer Fallback Reference

When `StandardRenderer` encounters restricted capabilities, it falls back automatically:

| Capability Missing | Fallback Behavior |
|--------------------|--------------------|
| `!supportsColor` | `#color()`, `#bold()`, `#dim()` return raw text. |
| `!supportsUnicode` | `#glyph()` returns ASCII from `#asciiFallback()`. Box drawing becomes `+|-`. |
| `!supportsAnimation` | `#spinnerFrame()` returns first frame statically. No timer started. |
| `terminalWidth < 40` | `#framedPanel()` truncates content. Tables may overflow. |

---

## 7. Channel-Safe Output

If your surface needs to work through channels (Telegram, Discord, Email), ensure it produces safe output when rendered through `PlainLogSurfaceAdapter`:

- No ANSI escape codes.
- No HTML unless the channel adapter explicitly supports it.
- No Markdown unless the channel adapter explicitly supports it.
- Emoji only when the channel adapter's `capabilities.supportsEmoji` is true.

The safest default is: build a clean ViewModel and let `renderPlain()` handle channel output.
