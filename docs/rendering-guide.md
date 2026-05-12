# Rendering Guide for Contributors (v0.95)

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

## 3. Common Patterns

### 3.1 Command Result with Nested Blocks

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

### 3.2 Table with Empty State

```typescript
buildTableViewModel({
  title: "Cron jobs",
  columns: [{ key: "id", header: "ID" }, { key: "name", header: "Name" }],
  rows: jobs.map(j => ({ id: j.id, name: j.name })),
  emptyMessage: "No cron jobs configured.",
});
```

### 3.3 Warning Banner

```typescript
buildWarningErrorViewModel({
  severity: "warn",
  title: "Missing config",
  message: "Telegram token is not set.",
  details: ["Set TELEGRAM_BOT_TOKEN in your environment."],
});
```

### 3.4 Approval Prompt

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

## 4. What NOT to Do

| Anti-pattern | Correct Approach |
|--------------|----------------|
| `lines.push(`[31mError[0m`)` | Return a `WarningErrorViewModel`, let the renderer apply severity color. |
| `if (isTTY) output.write(cursorHide)` | Gate on `capabilities.supportsAnimation`, use `AnimationController`. |
| `const icon = isEmoji ? `💎` : `*` | Define the icon in the skin token `toolIcon`, let the renderer pick based on capabilities. |
| `output.write(`┌${`─`.repeat(w)}┐`)` | Use `#framedPanel()` in `StandardRenderer` or plain text blocks in `PlainRenderer`. |
| `const lines = ["header", `  ${key}: ${value}`]` | Build a `KeyValueBlockViewModel` and render it. |
| Hardcoding command names in `/help` | Register commands in `CommandRegistry`, read from registry. |

---

## 5. Renderer Fallback Reference

When `StandardRenderer` encounters restricted capabilities, it falls back automatically:

| Capability Missing | Fallback Behavior |
|--------------------|--------------------|
| `!supportsColor` | `#color()`, `#bold()`, `#dim()` return raw text. |
| `!supportsUnicode` | `#glyph()` returns ASCII from `#asciiFallback()`. Box drawing becomes `+|-`. |
| `!supportsAnimation` | `#spinnerFrame()` returns first frame statically. No timer started. |
| `terminalWidth < 40` | `#framedPanel()` truncates content. Tables may overflow. |

---

## 6. Channel-Safe Output

If your surface needs to work through channels (Telegram, Discord, Email), ensure it produces safe output when rendered through `PlainLogSurfaceAdapter`:

- No ANSI escape codes.
- No HTML unless the channel adapter explicitly supports it.
- No Markdown unless the channel adapter explicitly supports it.
- Emoji only when the channel adapter's `capabilities.supportsEmoji` is true.

The safest default is: build a clean ViewModel and let `renderPlain()` handle channel output.
