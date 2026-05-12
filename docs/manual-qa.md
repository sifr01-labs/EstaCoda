# Manual QA Procedures (v0.95)

> **Purpose:** Validation steps that require human judgment or environment-specific verification beyond automated tests.

---

## 1. Snapshot QA Checklist

Run these checks after every test run:

```bash
pnpm run test
```

### 1.1 ANSI Leak Check

Verify no ANSI escape codes exist in plain-mode or no-color snapshots:

```bash
python3 -c "
import re, sys
total = 0
for path in [
    'src/cli/__snapshots__/session-surfaces.test.ts.snap',
    'src/cli/__snapshots__/gateway-surfaces.test.ts.snap',
    'src/cli/__snapshots__/tool-activity.test.ts.snap',
    'src/cli/__snapshots__/session-handoff-surfaces.test.ts.snap',
    'src/cron/__snapshots__/cron-surfaces.test.ts.snap',
]:
    with open(path) as f:
        content = f.read()
    matches = re.findall(r'exports\[`([^`]+)`\] = `\n(.*?)\n`;', content, re.DOTALL)
    for name, body in matches:
        if ('plain' in name or 'no color' in name) and '\x1b' in body:
            print(f'LEAK: {name} in {path}')
            total += 1
if total == 0:
    print('PASS: No ANSI leaks in plain/no-color snapshots')
else:
    print(f'FAIL: {total} leaks found')
    sys.exit(1)
"
```

**Expected:** `PASS`

### 1.2 Emoji Leak Check

Verify no emoji in plain-mode snapshots:

```bash
python3 -c "
import re, sys
total = 0
for path in [
    'src/cli/__snapshots__/session-surfaces.test.ts.snap',
    'src/cli/__snapshots__/gateway-surfaces.test.ts.snap',
    'src/cli/__snapshots__/tool-activity.test.ts.snap',
    'src/cli/__snapshots__/session-handoff-surfaces.test.ts.snap',
    'src/cron/__snapshots__/cron-surfaces.test.ts.snap',
]:
    with open(path) as f:
        content = f.read()
    matches = re.findall(r'exports\[`([^`]+)`\] = `\n(.*?)\n`;', content, re.DOTALL)
    for name, body in matches:
        if 'plain' not in name:
            continue
        for ch in body:
            cp = ord(ch)
            if 0x1f300 <= cp <= 0x1f9ff or 0x2600 <= cp <= 0x26ff or 0x2700 <= cp <= 0x27bf:
                print(f'LEAK: emoji U+{cp:04X} in {name}')
                total += 1
                break
if total == 0:
    print('PASS: No emoji in plain snapshots')
else:
    print(f'FAIL: {total} leaks found')
    sys.exit(1)
"
```

**Expected:** `PASS`

### 1.3 Box Drawing Leak Check

Verify no Unicode box-drawing characters in plain-mode snapshots:

```bash
python3 -c "
import re, sys
total = 0
for path in [
    'src/cli/__snapshots__/session-surfaces.test.ts.snap',
    'src/cli/__snapshots__/gateway-surfaces.test.ts.snap',
    'src/cli/__snapshots__/tool-activity.test.ts.snap',
    'src/cli/__snapshots__/session-handoff-surfaces.test.ts.snap',
    'src/cron/__snapshots__/cron-surfaces.test.ts.snap',
]:
    with open(path) as f:
        content = f.read()
    matches = re.findall(r'exports\[`([^`]+)`\] = `\n(.*?)\n`;', content, re.DOTALL)
    for name, body in matches:
        if 'plain' not in name:
            continue
        for ch in body:
            cp = ord(ch)
            if 0x2500 <= cp <= 0x257f:
                print(f'LEAK: box-drawing U+{cp:04X} in {name}')
                total += 1
                break
if total == 0:
    print('PASS: No box drawing in plain snapshots')
else:
    print(f'FAIL: {total} leaks found')
    sys.exit(1)
"
```

**Expected:** `PASS`

---

## 2. Environment Fallback QA

### 2.1 NO_COLOR=1

```bash
NO_COLOR=1 pnpm run dev
```

**Verify:**
- Startup screen has no ANSI colors.
- Prompt prefix is `> ` (not `𓂀 > `).
- No spinner animation on tool activity.
- Status rail uses ASCII labels (`sess`, `task`).

### 2.2 TERM=dumb

```bash
TERM=dumb pnpm run dev
```

**Verify:**
- Same as `NO_COLOR=1`.
- No ANSI cursor codes.
- `/clear` does not emit `c`.

### 2.3 Non-TTY Fallback

```bash
pnpm run dev | cat
```

**Verify:**
- Output is plain text.
- Interactive picker degrades to a numbered list (no ANSI cursor controls).
- No spinner animation.

### 2.4 Narrow Terminal

```bash
COLUMNS=40 pnpm run dev
```

**Verify:**
- Startup screen does not crash.
- Framed panels truncate to 40 columns.
- Tables may overflow but do not throw.

---

## 3. Provider-Token Streaming Validation

### 3.1 Procedure

1. Start an interactive session in a wide TTY:
   ```bash
   pnpm run dev
   ```

2. Send a prompt that triggers a long streaming response while tools execute:
   ```
   Analyze the src/ directory and list all TypeScript files, then summarize the architecture.
   ```

3. **Observe:**
   - Provider tokens appear contiguously on the output line.
   - No missing characters, no duplicated text, no ANSI corruption.
   - Tool activity lines appear above the token stream, not interleaved into it.
   - No cursor movement escape codes appear in the token text.

4. **Confirm:** The final response is readable and complete.

### 3.2 Automated Proxy

The `session-surfaces.test.ts` includes a test proving `createSessionRenderer` with full TTY caps returns a renderer that produces ANSI, while plain/non-TTY/CI/dumb/no-color caps produce no ANSI. This is the automated proxy for streaming safety.

---

## 4. Startup and Picker QA

### 4.1 Startup Screen

```bash
pnpm run dev
```

**Verify standard mode:**
- Hero panel shows `𓂀 EstaCoda` in brand color.
- Taglines render (Kemet Research + Arabic tagline in KemetBlue skin).
- Model info shows on a rail line (`| model: provider/model-id`).
- Readiness state is color-coded: green `ready`, amber `degraded`, red `missing-config`.

**Verify plain mode:**
```bash
NO_COLOR=1 pnpm run dev
```
- Simple text block: `EstaCoda`, taglines, `model: ...`, `readiness: ready`.
- No ANSI, no box frames.

### 4.2 Picker

In an interactive session:
```
/model
```

**Verify TTY:**
- Numbered list with `>` cursor indicator.
- Arrow keys move selection.
- Enter confirms.

**Verify non-TTY:**
```bash
echo "1" | pnpm run dev
```
- Numbered list prints without cursor controls.
- Selection is read from stdin.

---

## 5. Input Rail-Frame QA

### 5.1 Standard Mode

```bash
pnpm run dev
```

Send any message. Between turns, verify:
- A thin horizontal rule (`───...`) separates turns.
- No full box frame around the input area.
- Prompt prefix is `𓂀 > `.

### 5.2 Plain Mode

```bash
NO_COLOR=1 pnpm run dev
```

Verify:
- Horizontal rule uses ASCII dashes (`---...`).
- Prompt prefix is `> `.

---

## 6. Status Rail Timer QA

Trigger a multi-tool session:
```
Read src/cli/cli.ts and summarize the first 50 lines.
```

**Verify:**
- Status rail shows active tool count.
- Session timer increments (`◷ 5.2s`).
- Task timer increments (`⧖ 1.3s`).
- In plain mode: `sess 5.2s  task 1.3s`.
- When idle: `task idle` or `⧖ idle`.

---

## 7. Assistant Response Framing QA

Send any prompt that produces a response.

**Verify standard mode:**
- Response header: `╭───...` with `𓂀 EstaCoda` inside.
- Response text follows inside the frame.
- Matched skills shown below frame: `skills: skill-a, skill-b`.

**Verify plain mode:**
- Response header: `EstaCoda:`
- No box frame.
- Skills shown as `skills: skill-a, skill-b`.

---

## 8. Command Registry QA

```bash
pnpm run dev
/help
```

**Verify:**
- `/help` output contains exactly the commands registered in `src/cli/command-registry.ts`.
- No hardcoded commands missing from the registry.
- Descriptions match registry descriptions.

---

## 9. Channel-Safe Output QA

### 9.1 Plain Log Adapter

The `PlainLogSurfaceAdapter` is used for CI/logs. Verify its output:

```typescript
import { PlainLogSurfaceAdapter } from "./src/channels/surface-adapters/plain-log-surface-adapter.js";
const adapter = new PlainLogSurfaceAdapter();
const output = adapter.render(/* any ViewModel */);
```

**Verify:**
- `output` contains no ANSI escape codes.
- `output` contains no emoji.
- `output` contains no HTML tags.

---

## 10. Reviewed Setup QA

Use an isolated home so no real credentials or trust state are touched:

```bash
rm -rf /tmp/estacoda-setup-qa-home
mkdir -p /tmp/estacoda-setup-qa-home
HOME=/tmp/estacoda-setup-qa-home pnpm run dev -- setup
```

**Verify:**
- Setup starts from `estacoda setup`, not from a runtime tool.
- Language selection appears early.
- Workspace trust is explicit.
- Provider/model setup is separate from optional capabilities.
- Optional capabilities can be skipped independently.
- A review appears before any apply/write step.
- Raw secret values are not shown in review, logs, or final output.
- Verification runs after approved apply and reports structured readiness.
- Launch handoff happens only after verified-ready or explicitly accepted degraded setup.

Arabic setup spot check:

```bash
HOME=/tmp/estacoda-setup-qa-home-ar pnpm run dev -- setup
```

Choose Arabic and verify that commands, provider names, paths, and env vars remain readable with LTR isolation. This checks onboarding-owned setup surfaces only; full runtime CLI localization is not complete.

---

## 11. Regression Gate

Before any commit that touches rendering code, run:

```bash
pnpm run test
pnpm run typecheck
pnpm run smoke
```

All three must pass. Snapshot changes must be reviewed for unexpected ANSI/emoji/box-drawing leaks.
