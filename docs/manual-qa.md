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

In any supported flow that opens the shared interactive picker, such as setup language selection or a command menu:

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

## 10. Reviewed Setup And Guided Repair QA

Use an isolated home so no real credentials or trust state are touched:

```bash
rm -rf /tmp/estacoda-setup-qa-home
mkdir -p /tmp/estacoda-setup-qa-home
HOME=/tmp/estacoda-setup-qa-home pnpm run dev -- setup --interactive
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

### 10.1 First-Run Setup

```bash
rm -rf /tmp/estacoda-qa-first-run
mkdir -p /tmp/estacoda-qa-first-run
HOME=/tmp/estacoda-qa-first-run pnpm run dev -- setup --interactive
```

**Verify:**
- First-run setup starts because no usable config exists.
- Primary provider/model setup uses the shared provider/model picker.
- Hosted provider credential input is masked.
- Review shows env var references, not raw key values.
- Cancelling review leaves no config, trust, state, or `.env` mutation from the cancelled plan.

### 10.2 Configured Ready

Use a disposable home with a known-good local or hosted config.

```bash
HOME=/tmp/estacoda-qa-ready pnpm run dev -- setup --interactive
```

**Verify:**
- The guided setup editor opens instead of first-run setup.
- Available actions include review/edit, read-only verification, launch after verification, and exit.
- Exiting writes nothing.
- Running verification is read-only.

### 10.3 Configured Degraded

Use a disposable config that verifies with warnings, such as a low context-window model or another known non-blocking warning.

```bash
HOME=/tmp/estacoda-qa-degraded pnpm run dev -- setup --interactive
```

**Verify:**
- Concrete verification warnings are shown.
- Launch is not automatic.
- Limited mode requires explicit acceptance after warnings are visible.
- Choosing repair re-enters the guided setup editor.

### 10.4 Partial Provider / Broken Route

Use a disposable config whose primary provider/model route is incomplete or points at a non-runnable setup-visible route.

```bash
HOME=/tmp/estacoda-qa-partial-provider pnpm run dev -- setup --interactive
```

**Verify:**
- Setup opens repair-first guided editor behavior.
- Provider/model repair uses the shared provider/model flow.
- Review/apply drafts route/auth-shaped config changes.
- Direct setup compatibility is not presented as the preferred repair path.

### 10.5 Missing Credential

Use a disposable config with a hosted provider route and a missing credential env var.

```bash
HOME=/tmp/estacoda-qa-missing-credential pnpm run dev -- setup --interactive
```

**Verify:**
- Credential repair targets the active route only.
- Review displays env var references only.
- The raw API key is not printed in review, diagnostics, logs, output, or final result text.
- Cancelling review writes no `.env`.
- Approving review writes only after approval.

### 10.6 Broken Config

```bash
rm -rf /tmp/estacoda-qa-broken-config
mkdir -p /tmp/estacoda-qa-broken-config/.estacoda/profiles/default
printf '{"profileId":"default"}' > /tmp/estacoda-qa-broken-config/.estacoda/active-profile.json
printf '{not-json' > /tmp/estacoda-qa-broken-config/.estacoda/profiles/default/config.json
HOME=/tmp/estacoda-qa-broken-config pnpm run dev -- setup --interactive
```

**Verify:**
- Output shows config path(s) and parse/load error.
- Normal provider/model/security/workflow edits are not offered.
- Only diagnostics, read-only verification, manual repair guidance, and exit are available.
- No normal config patch is drafted while config is unsafe.

### 10.7 Untrusted Workspace

Use a disposable home and workspace that is not in the trust store.

```bash
HOME=/tmp/estacoda-qa-untrusted pnpm run dev -- setup --interactive
```

**Verify:**
- Workspace trust is shown as separate from provider/model readiness.
- Trust grant requires explicit confirmation.
- Review appears before trust is applied.
- Cancelling review does not update the trust store.

### 10.8 State Not Writable

```bash
rm -rf /tmp/estacoda-qa-state
mkdir -p /tmp/estacoda-qa-state/.estacoda
chmod 500 /tmp/estacoda-qa-state/.estacoda
HOME=/tmp/estacoda-qa-state pnpm run dev -- setup --interactive
chmod 700 /tmp/estacoda-qa-state/.estacoda
```

**Verify:**
- Output explains that the state/config path is not writable.
- Normal writes are blocked until state writability is restored.
- Permission guidance is shown.
- Verification retry and exit are available; launch is not.

### 10.9 Optional Capability Editor

From a configured disposable setup:

```bash
HOME=/tmp/estacoda-qa-ready pnpm run dev -- setup --interactive
```

**Verify:**
- Optional capabilities are presented independently from the primary provider/model route.
- `Leave unchanged` writes nothing.
- `Skip` keeps core setup valid and non-blocking.
- `Enable/configure` produces reviewed drafts for only the selected capability.
- Telegram/channels shows remote-control risk and requires allowed user or chat identities.
- Telegram token is an env var reference only.
- Voice setup remains a native optional capability and does not change the primary LLM route.
- Vision/image generation remains a native optional capability and does not change the primary LLM route.
- Browser setup records references only and does not auto-launch a browser during planning.

### 10.10 Review, Cancel, And Raw Secret Safety

For any setup path that collects credentials:

1. Enter a fake secret value such as `sk-manual-qa-do-not-store`.
2. Continue to review.
3. Cancel review.

**Verify:**
- Review does not show `sk-manual-qa-do-not-store`.
- Terminal output does not show `sk-manual-qa-do-not-store`.
- `.env` is not created or changed by the cancelled review.
- Config and trust store are not changed by the cancelled review.
- Re-running setup still treats the credential as missing.

Then repeat and approve review.

**Verify:**
- `.env` is written only after approval.
- Review and final output still do not print the raw secret.
- Verification is read-only after apply.

### 10.11 Blocked Launch Denial

Use a missing credential, broken config, untrusted workspace, state-not-writable home, or failed verification state.

**Verify:**
- Launch is not offered from unsafe states.
- Failed or blocked verification does not launch.
- The next action is repair again or exit.

Arabic setup spot check:

```bash
HOME=/tmp/estacoda-setup-qa-home-ar pnpm run dev -- setup --interactive
```

Choose Arabic and verify that commands, provider names, paths, and env vars remain readable with LTR isolation. This checks onboarding-owned setup surfaces only; full runtime CLI localization is not complete.

---

## 11. Package Installability QA

Run this from a clean checkout after dependency install:

```bash
pnpm run build
head -n 1 dist/index.js
node dist/index.js --version
node dist/index.js --help
npm pack --dry-run
scripts/verify-package-bin.sh
```

**Verify:**
- `dist/index.js` starts with `#!/usr/bin/env node`.
- Local compiled `--version` and `--help` exit successfully.
- `npm pack --dry-run` includes `dist/index.js`, `skills/`, `assets/`, `workers/`, and `acp_registry/`.
- `scripts/verify-package-bin.sh` installs the packed tarball into a temporary prefix and runs that installed `estacoda` binary.
- Public `npm install -g estacoda`, `npx estacoda`, and hosted curl install are not claimed until release validation proves them.

## 12. Regression Gate

Before any commit that touches rendering code, run:

```bash
pnpm run test
pnpm run typecheck
pnpm run smoke
```

All three must pass. Snapshot changes must be reviewed for unexpected ANSI/emoji/box-drawing leaks.
