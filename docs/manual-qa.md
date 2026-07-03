# Manual QA Procedures

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

### 2.1 Papyrus Full Interactive Migration Matrix

Run these checks in a real interactive TTY after changing session rendering,
prompt input, slash autocomplete, approvals, paste handling, resize behavior, or
terminal lifecycle cleanup.

| Scenario | Command | Verify |
|----------|---------|--------|
| Default launch | `estacoda` | Startup and Operator Console surfaces use the Papyrus session surface. Input uses the raw prompt path. `/status` shows shell history, clipboard, MCP suggestions, skill suggestions, and Vim keymap as `off` unless explicitly enabled. |
| Removed renderer flag | `ESTACODA_UI_RENDERER=legacy estacoda` | The flag is ignored. Session output still uses the Papyrus renderer/Operator Console path. |
| Removed input flag | `ESTACODA_INPUT_MODE=readline estacoda` | The flag is ignored for interactive sessions. The prompt still uses the raw Papyrus input path. |
| Slash autocomplete | `estacoda` then type `/` | The Operator Console slash menu appears below the prompt and above the status rail. Arrow keys and `Ctrl-N`/`Ctrl-P` move focus. `Escape` dismisses the menu without cancelling the prompt. |
| Approval ask | `estacoda` then run a prompt that triggers a command or file approval | Promptable approvals render as Papyrus approval cards. Hardline/policy-denied actions do not render approval cards. |
| Paste | `estacoda` then paste single-line and multiline text | Small single-line paste remains inline. Multiline/large paste uses the existing compact paste reference behavior and submits the original pasted content. |
| Resize | `estacoda` then resize narrower and wider while idle, during slash autocomplete, and during active-turn chrome | Prompt rows, slash menu rows, and Operator Console regions reflow without full-screen clear, scrollback clear, or overlapping text. Focused slash rows remain visible. |
| Cancel/EOF | `estacoda`, then press `Ctrl-C`; relaunch and press `Ctrl-D` on an empty prompt | `Ctrl-C` cancels/cleans up the raw prompt. `Ctrl-D` exits cleanly from an empty prompt. Terminal raw mode is restored after each exit path. |

The renderer/input rollout flags are removed and should no longer activate
legacy interactive modes:

```bash
ESTACODA_UI_RENDERER=legacy estacoda
ESTACODA_INPUT_MODE=readline estacoda
```

Optional Papyrus helpers remain disabled unless explicitly configured:

```bash
ESTACODA_INPUT_KEYMAP=vim estacoda
ESTACODA_SHELL_HISTORY=1 estacoda
ESTACODA_CLIPBOARD=1 estacoda
ESTACODA_MCP_SUGGESTIONS=1 estacoda
ESTACODA_SKILL_SUGGESTIONS=1 estacoda
```

No Slack suggestion provider is enabled by default.

### 2.1.1 Terminal Recovery

Use these recovery steps if a local terminal is left in an odd state after a
crash, forced kill, or interrupted manual test:

| Symptom | Recovery |
|---------|----------|
| Screen contains stale cursor control output or prompt rows | Run `reset`, then relaunch `estacoda`. |
| Input is not echoing, line editing is broken, or raw mode appears stuck | Run `stty sane`, then press `Enter`. |
| Cursor remains hidden | Run `printf '\033[?25h\n'` or `reset`. |
| Bracketed paste mode appears stuck | Run `printf '\033[?2004l\n'`, then `stty sane`. |
| Prompt does not echo after `Ctrl-C`/`Ctrl-D` testing | Run `stty sane`; if needed, close and reopen the terminal tab. |

### 2.2 NO_COLOR=1

```bash
NO_COLOR=1 pnpm run dev
```

**Verify:**
- Startup screen has no ANSI colors.
- Prompt prefix is `> ` (not `𓂀 > `).
- No spinner animation on tool activity.
- Status rail uses ASCII labels (`sess`, `task`).

### 2.3 TERM=dumb

```bash
TERM=dumb pnpm run dev
```

**Verify:**
- Same as `NO_COLOR=1`.
- No ANSI cursor codes.
- `/clear` does not emit `c`.

### 2.4 Non-TTY Fallback

```bash
pnpm run dev | cat
```

**Verify:**
- Output is plain text.
- Interactive picker degrades to a numbered list (no ANSI cursor controls).
- No spinner animation.

### 2.5 Narrow Terminal

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

## 3.3 Native Tool-Call Replay QA

Run these checks when changing provider finalization, tool-call persistence, prompt assembly, native history selection, provider serialization, semantic compression, or diagnostics.

### Supported Chat Completions Route

1. Configure a tested OpenAI-compatible Chat Completions route that supports tools and native history.
2. Start a local session:
   ```bash
   pnpm run dev
   ```
3. Ask for a task that requires at least one tool call.
4. Inspect the resulting trace/session events:
   ```bash
   estacoda trace list --limit 5
   estacoda trace dump <trajectory-id> --raw
   ```

**Verify:**
- Provider tool-call turns persist before tool execution.
- Stable tool-call IDs match between the persisted provider turn and tool result metadata.
- `structured-tool-history-selected` and, where applicable, `structured-tool-history-serialized` events appear.
- Diagnostic payloads are counts and reasons only.
- No raw arguments, tool results, echo values, raw reasoning, request bodies, paths, hashes, or prompt content appear in diagnostics.

### Unsupported Provider Fallback

Run the same tool-using prompt on an unsupported route, a Responses route, or an Anthropic route.

**Verify:**
- No native assistant `tool_calls` or native `tool` history is sent.
- Flat session history fallback remains usable.
- `structured-tool-history-skipped` records a coarse reason such as `provider_unsupported` or `serialization_unsupported`.
- The final answer still follows the normal tool continuation path.

### Missing Echo Fail-Closed

Use a tested echo-required thinking route only if available in the operator environment.

**Verify:**
- Same-provider/API-mode echo is required before native replay.
- Missing or mismatched echo disables native replay for that provider tool-call turn.
- No placeholder echo is used unless the route has an explicitly tested placeholder path.
- Echo values do not appear in flat prompt text, diagnostics, logs, traces, summaries, or memory.

### Unsafe Argument Redaction

Ask the model to inspect or search for a credential-like token name, not a real secret.

**Verify:**
- If a provider tool-call argument contains obvious credential material, the whole provider tool-call turn is `nativeReplaySafe: false`.
- Affected calls omit faithful `argumentsText` and set `argumentsRedacted: true`.
- The unsafe turn is not replayed as native assistant/tool protocol history.
- Diagnostics count `unsafe_arguments` without recording the sensitive argument.

### Multi-Call Atomicity

Use or simulate a provider turn that emits multiple tool calls.

**Verify:**
- All call IDs have matching tool result messages before native serialization.
- Missing or malformed tool results fail closed for the whole native group.
- The serializer does not emit partial assistant `tool_calls` or partial native tool replies.
- Semantic compression keeps the whole group or compresses the whole group.

### Continuation With Native History

Use a tool call that requires a second provider pass after tool execution.

**Verify:**
- Supported routes include selected assistant/tool history as structured native messages.
- The final continuation instruction remains the last user message.
- Tool results already selected as native `tool` messages do not appear again in the flat `Executed tool results` block.
- Non-selected tool results still appear in flat continuation text.

### Compression Excluding Echo

Force or simulate a long session where old tool history is compressed.

**Verify:**
- Selected native groups bypass compression.
- Unselected groups feed compression only after echo and raw reasoning fields are stripped.
- Active or incomplete provider tool groups remain protected.
- Generated summaries contain no echo values, raw reasoning, or faithful secret-bearing arguments.

---

## 4. Startup and Picker QA

### 4.1 Startup Screen

```bash
pnpm run dev
```

**Verify standard mode:**
- Hero panel shows `𓂀 EstaCoda` in brand color.
- Taglines render (`⟡ SIFR01 ⟡` + Arabic tagline in KemetBlue skin).
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
- The normal Onboarding Wizard shows a configuration summary and confirmation before apply; it does not show the technical manifest as the normal user-facing screen.
- Raw secret values are not shown in summary, review, logs, or final output.
- Verification runs after approved apply and reports structured readiness.
- `Start EstaCoda now?` appears only after apply and verification. It is not a pre-apply preference.
- Launch handoff reloads config and trust, verifies workspace trust, rebuilds runtime from fresh config, and then enters the normal interactive launcher.

### 10.1 Onboarding Wizard

```bash
rm -rf /tmp/estacoda-qa-first-run
mkdir -p /tmp/estacoda-qa-first-run
HOME=/tmp/estacoda-qa-first-run pnpm run dev -- setup --interactive
```

**Verify:**
- The Onboarding Wizard starts because no usable config exists.
- The visible sequence is setup detection, profile bootstrap, welcome, language/style, workspace, workspace trust, model route, endpoint/credential handling as needed, safety, Agent Evolution, optional capabilities, summary, apply, launch.
- Primary provider/model setup uses the shared provider/model picker.
- Choosing the built-in local provider uses Local / Custom Endpoint behavior: endpoint URL is prompted with a default, blank keeps the default, invalid URLs retry before review, and the API key prompt is optional.
- `Back` appears selectively on structured choice prompts where it prevents dead ends: workspace trust, provider/model, credential handling, security mode, Agent Evolution, optional capabilities, nested optional capability choices, and the final summary. Verify that `Back` returns to the previous meaningful step, preserves already entered values as current/default selections, and does not add `/back` handling to raw text or secret prompts.
- Hosted provider credential input is masked.
- Local / Custom Endpoint no-auth leaves credential state as none; entering an optional API key shows only the env-var reference and writes the raw key only after reviewed apply.
- In Setup Editor, selecting Local / Custom for primary, fallback, or auxiliary routes shows the same endpoint-first Papyrus flow before model selection. Primary writes the primary route, fallback writes only `model.fallbacks`, and auxiliary writes only the selected `auxiliaryModels.<task>` slot.
- Credential summary shows only `Not set`, `Existing credential detected`, or `New credential pending`.
- Cancelling before apply leaves no config, trust, state, or `.env` mutation from the cancelled plan.
- Deferring workspace trust may save setup but must show `Setup saved. Workspace trust is still required before EstaCoda can run here.` and must not offer launch.

### 10.2 Configured Ready

Use a disposable home with a known-good local or hosted config.

```bash
HOME=/tmp/estacoda-qa-ready pnpm run dev -- setup --interactive
```

**Verify:**
- The Setup Editor opens instead of the Onboarding Wizard.
- Available actions include primary model route edit, fallback route edit, auxiliary route edit, optional capability configuration, security mode edit, Agent Evolution edit, EstaCoda Doctor, and exit.
- Exiting writes nothing.
- Choosing EstaCoda Doctor is read-only and shows setup health, required fixes, and provider route status.

### 10.3 Configured Degraded

Use a disposable config that verifies with warnings, such as a low context-window model or another known non-blocking warning.

```bash
HOME=/tmp/estacoda-qa-degraded pnpm run dev -- setup --interactive
```

**Verify:**
- Concrete verification warnings are shown.
- Launch is not automatic.
- Limited mode requires explicit acceptance after warnings are visible.
- Choosing repair re-enters the Setup Editor.

### 10.4 Partial Provider / Broken Route

Use a disposable config whose primary provider/model route is incomplete or points at a non-runnable setup-visible route.

```bash
HOME=/tmp/estacoda-qa-partial-provider pnpm run dev -- setup --interactive
```

**Verify:**
- Setup opens repair-first Setup Editor behavior.
- Provider/model repair uses the shared provider/model flow.
- Review/apply drafts route/auth-shaped config changes. Endpoint/base URL changes appear in provider-route review values, not credential-only drafts.
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
- Output shows EstaCoda Doctor with the config syntax/load error.
- Normal provider/model/security/workflow edits are not offered.
- Only EstaCoda Doctor and exit are available.
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

### 10.9 Configure Channels

From a configured disposable setup:

```bash
HOME=/tmp/estacoda-qa-ready pnpm run dev -- setup --interactive
```

**Verify:**
- Selecting `configure-channels` creates a single-module draft bundle for channels only.
- Telegram shows remote-control risk and requires allowed user or chat identities.
- Telegram token is an env var reference only.
- `Leave unchanged` writes nothing.
- `Skip` keeps core setup valid and non-blocking.

### 10.10 Configure Voice

From a configured disposable setup:

```bash
HOME=/tmp/estacoda-qa-ready pnpm run dev -- setup --interactive
```

**Verify:**
- Selecting `configure-voice` creates a single-module draft bundle for voice only.
- Voice setup does not change the primary LLM route.
- STT and TTS can be configured independently.
- `Leave unchanged` writes nothing.
- `Skip` keeps core setup valid and non-blocking.

### 10.11 Configure Image Generation

From a configured disposable setup:

```bash
HOME=/tmp/estacoda-qa-ready pnpm run dev -- setup --interactive
```

**Verify:**
- Selecting `configure-image-generation` creates a single-module draft bundle for vision only.
- Image generation setup does not change the primary LLM route.
- Image generation remains a Setup Editor capability. It must not appear in the Onboarding Wizard optional capability menu.
- `Leave unchanged` writes nothing.
- `Skip` keeps core setup valid and non-blocking.

### 10.12 Configure Browser

From a configured disposable setup:

```bash
HOME=/tmp/estacoda-qa-ready pnpm run dev -- setup --interactive
```

**Verify:**
- Selecting `configure-browser` creates a single-module draft bundle for browser only.
- Browser setup records references only and does not auto-launch a browser during planning.
- `Leave unchanged` writes nothing.
- `Skip` keeps core setup valid and non-blocking.

### 10.12.1 Browser Parity QA

Use disposable state for all browser checks:

```bash
rm -rf /tmp/estacoda-browser-qa-home
mkdir -p /tmp/estacoda-browser-qa-home
```

**Local supervised auto-launch:**

```bash
HOME=/tmp/estacoda-browser-qa-home pnpm run dev -- browser setup --backend local-cdp --auto-launch --launch-executable /path/to/chrome --launch-arg --headless=new --chrome-flag --no-first-run
HOME=/tmp/estacoda-browser-qa-home pnpm run dev -- browser status
```

**Verify:**
- Status shows `local-cdp`, supervised mode, auto-launch enabled, launch executable, launch args count, and Chrome flags count.
- Runtime navigation can launch Chrome/Chromium only from the configured structured executable/argument fields.
- `browser.launchCommand` is not split, guessed, or shell-parsed.
- Cleanup kills only the Chrome process launched by EstaCoda and removes the temporary user data directory.

**Browserbase approval gate:**

Use repo test conventions or mocked/safe placeholder credentials. Do not use real billing credentials in shared QA logs.

```bash
HOME=/tmp/estacoda-browser-qa-home pnpm run dev -- browser setup --backend browserbase --cloud-provider browserbase
HOME=/tmp/estacoda-browser-qa-home pnpm run dev -- browser status
```

**Verify:**
- Browserbase credentials/config do not create a session.
- Navigation that would require Browserbase fails while `browser.cloudSpendApproved` is `"pending"` or `false`.
- The error explains that cloud browser sessions may incur charges and points to `estacoda browser approve-cloud`.
- Missing spend approval does not fall back to local even when `browser.cloudFallback: true`.

**Browserbase approved path:**

```bash
HOME=/tmp/estacoda-browser-qa-home pnpm run dev -- browser approve-cloud
HOME=/tmp/estacoda-browser-qa-home pnpm run dev -- browser status
```

**Verify:**
- Status/config shows cloud spend approval as approved where surfaced.
- With safe mocked Browserbase responses or an operator-owned Browserbase project, Browserbase session creation uses `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`.
- `estacoda browser revoke-cloud` blocks future cloud session creation without deleting credentials.

**Hybrid routing and URL safety:**

Configure Browserbase plus local CDP with `browser.hybridRouting: true`.

**Verify:**
- Public HTTP(S) navigation routes to cloud when Browserbase is configured and spend approval is true.
- Private/internal navigation is blocked when `security.allowPrivateUrls: false`.
- Private/internal navigation routes to local only when `security.allowPrivateUrls: true`.
- Metadata targets such as `169.254.169.254`, `169.254.170.2`, `metadata.google.internal`, and `100.100.100.200` are hard-blocked even when private URLs are allowed.
- Unsafe redirects are navigated to `about:blank` when possible; if cleanup fails, the unsafe session is closed.
- Tool status or metadata reports the last backend/fallback state where surfaced and does not print secrets or raw Browserbase response bodies.

### 10.13 Fallback Route Editor

From a configured disposable setup with at least one fallback route configured:

```bash
HOME=/tmp/estacoda-qa-ready pnpm run dev -- setup --interactive
```

**Verify:**
- `edit-fallback-model-route` is available from configured-ready state.
- When no fallbacks exist, it prompts to add a new fallback route.
- When fallbacks exist, it prompts to select an existing fallback to replace or add another.
- Review shows the full fallback chain (existing plus change).
- Replace preserves the order of remaining fallbacks.
- Add appends after existing fallbacks.

### 10.14 Auxiliary Route Editor

From a configured disposable setup:

```bash
HOME=/tmp/estacoda-qa-ready pnpm run dev -- setup --interactive
```

**Verify:**
- `edit-auxiliary-model-route` is available from configured-ready state.
- The task prompt shows the approved tasks: assessor, compression, session_search, memory_compaction, and profile_context.
- Assessor is explicitly described as approval-assessment in the prompt copy.
- Review is explicit about which auxiliary task is being configured.
- Applying sets the correct `auxiliaryModels.<task>` route.

### 10.15 Review, Cancel, And Raw Secret Safety

For any setup path that collects credentials:

1. Enter a fake secret value such as `sk-man...tore`.
2. Continue to review.
3. Cancel review.

**Verify:**
- Review does not show `sk-man...tore`.
- Terminal output does not show `sk-man...tore`.
- `.env` is not created or changed by the cancelled review.
- Config and trust store are not changed by the cancelled review.
- Re-running setup still treats the credential as missing.

Then repeat and approve review.

**Verify:**
- `.env` is written only after approval.
- Review and final output still do not print the raw secret.
- Verification is read-only after apply.

### 10.16 Blocked Launch Denial

Use a missing credential, broken config, untrusted workspace, state-not-writable home, or failed verification state.

**Verify:**
- Launch is not offered from unsafe states.
- Failed or blocked verification does not launch.
- The next action is repair again or exit.

Arabic setup spot check:

```bash
HOME=/tmp/estacoda-setup-qa-home-ar pnpm run dev -- setup --interactive
```

Choose Arabic and verify that commands, provider names, paths, and env vars remain readable with LTR isolation. This checks setup-owned localized surfaces only; full runtime CLI localization is not complete.

### 10.17 Papyrus Operator Prompt Migration Matrix

Run these checks in a real interactive TTY after changing setup/operator prompt
construction, the Papyrus prompt factory, interactive select widgets, or
fallback prompt selection. Use disposable homes and fake credentials only.

| Scenario | Command | Verify |
|----------|---------|--------|
| Default setup command | `estacoda setup` | Owned prompts route through the Papyrus-capable prompt factory. Existing first-run, configured, degraded, and repair routing behavior stays the same. |
| Explicit interactive setup | `estacoda setup --interactive` | Interactive setup uses the same Papyrus-capable prompt factory as the default setup path. `Back`, cancel, review, apply, and launch-after-verify behavior remain unchanged. |
| Advanced setup | `estacoda setup --advanced` | Advanced options remain available. Prompt implementation selection changes only through the factory; setup business logic does not change. |
| First-run disposable home | `ESTACODA_HOME=/tmp/estacoda-pr6a-first-run estacoda setup --interactive` | First-run onboarding appears, language/style selection stays early, workspace trust is explicit, and summary/review appears before any config or secret write. |
| Configured or degraded setup | `ESTACODA_HOME=/tmp/estacoda-pr6a-ready estacoda setup --interactive` | Configured-ready opens the Setup Editor. Degraded state shows warnings and repair choices. Verification remains read-only until an explicit apply path. |
| Untrusted workspace | `ESTACODA_HOME=/tmp/estacoda-pr6a-untrusted estacoda setup --interactive` | Workspace trust remains a separate explicit prompt. Cancelling trust review does not update the trust store. |
| Codex model setup | `estacoda model setup codex` | Model/OAuth/device-code behavior is unchanged. Any owned confirmation or text prompt uses the factory, while OAuth codes and URLs remain visible only where intended. |
| Voice setup | `estacoda voice setup` | Voice setup confirmations route through the factory. STT/TTS choices do not change the primary LLM route. |
| Image setup | `estacoda image setup` | Image setup secret prompts stay no-echo, do not expose paste previews, and do not print raw API keys in review, logs, or final output. |
| Telegram setup | `estacoda telegram setup` | Telegram risk copy, allowed user/chat prompts, and token handling remain unchanged. Token input is secret and review shows env-var references only. |
| WhatsApp wizard | `estacoda whatsapp` | The wizard uses the migrated prompt path where it owns prompts. Cancellation leaves profile config unchanged, and QR/pairing behavior remains unchanged. |
| Pack install/enable prompts | `estacoda pack install <pack>` and `estacoda pack enable <id>` | Confirmation/cancellation behavior is unchanged. Non-interactive output remains plain, and injected prompts in tests/internal callers still bypass factory creation. |
| Python environment prompts | `estacoda python-env setup <capability>` and `estacoda python-env reset <capability>` | Setup/reset confirmations route through the factory. Capability install/reset semantics and cancellation behavior are unchanged. |
| Interactive select menus | Any setup/editor menu with choices | TTY menus use Papyrus select widgets. Numeric fallback selection, selected output line, badges, table columns, back/cancel, narrow width, Arabic, and mixed LTR technical-token rendering remain stable. |
| Arabic setup path | Choose Arabic during `estacoda setup --interactive` | Arabic setup copy remains direction-aware. Commands, paths, provider names, env vars, and technical tokens remain readable with LTR isolation. |
| Secret no-echo check | Enter a fake API key/token in any setup credential prompt | Typed or pasted secret text does not echo, does not produce paste preview rows, and does not appear in review, logs, output, or final result text. |
| Back/cancel behavior | Use `Back`, `Cancel`, `Esc`, or `Ctrl-C` in setup/editor prompts | `Back` returns to the previous meaningful structured step where supported. Cancel before apply leaves config, trust, and `.env` unchanged. Terminal state is restored. |
| Non-TTY summary/plain output | Pipe setup/help output, for example `estacoda setup --help \| cat` or run a non-interactive setup path in CI | Output remains plain and deterministic, with no cursor controls, raw prompt behavior, or Papyrus select cursor movement. |

The renderer/input rollout flags no longer activate alternate interactive modes:

```bash
ESTACODA_UI_RENDERER=legacy estacoda setup --interactive
ESTACODA_INPUT_MODE=readline estacoda setup --interactive
```

Optional Papyrus helpers remain opt-in:

```bash
ESTACODA_INPUT_KEYMAP=vim estacoda
ESTACODA_SHELL_HISTORY=1 estacoda
ESTACODA_CLIPBOARD=1 estacoda
ESTACODA_MCP_SUGGESTIONS=1 estacoda
ESTACODA_SKILL_SUGGESTIONS=1 estacoda
```

No Slack suggestion provider is enabled by default.

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

## 13. WhatsApp Manual QA

Automated smoke covers fake wizard flows and package boundaries. Do not mark real-device WhatsApp checks as passed without a real WhatsApp account/session.

### 13.1 No-Device Checks

```bash
pnpm run smoke --id whatsapp-support
pnpm exec vitest run src/cli/whatsapp-wizard.test.ts src/channels/whatsapp-diagnostics.test.ts
pnpm run verify:package-bin
```

**Verify:**
- `estacoda whatsapp` wizard cancellation leaves profile config unchanged.
- Declining bridge dependency repair leaves profile config unchanged.
- Successful fake QR setup writes only expected WhatsApp keys: `enabled`, `experimental`, `authDir`, `mode`, `dmPolicy`, `groupPolicy`, `allowedUsers`, `allowedGroups`, `mentionPatterns`, `freeResponseChats`, `replyPrefix`, and `pairingMode`.
- Arabic wizard output preserves technical tokens including `estacoda whatsapp`, `WhatsApp`, `Baileys`, `dmPolicy`, `allowedUsers`, `authDir`, and `scripts/whatsapp-bridge/`.
- The root package includes the four bridge helper files and excludes `scripts/whatsapp-bridge/node_modules/`.
- The root package and root runtime do not depend on Baileys or `@hapi/boom`.

### 13.2 Real-Device Checks

Run only with an account you are willing to use with the unofficial Baileys API.

```bash
estacoda whatsapp
estacoda gateway diagnose
estacoda gateway status
estacoda gateway run
```

**Verify:**
- QR is rendered in the terminal and expires after 120 seconds with `Pairing timed out - run estacoda whatsapp to try again.` if not scanned.
- Missing bridge dependencies prompt before install; `ESTACODA_WHATSAPP_BRIDGE_INSTALL_TIMEOUT` controls the explicit repair timeout.
- Logged-out state reports clearly and requires explicit re-pair/reset.
- `dmPolicy: "pairing"` is shown as waiting for user authorization, not ready/open.
- Allowlisted-ready, open-policy, bot mode, self-chat mode, group policy, and queue pressure states are distinguishable in diagnostics/status.
- WhatsApp sends final replies only; progress is typing presence, not visible progress text.
- Voice-hinted OGG/Opus sends as a voice/PTT bubble. Incompatible audio uses `ffmpeg` conversion when available and falls back to normal audio when unavailable.
- Bridge logs are written to `logs/whatsapp-bridge.log`; install repair logs are written to `logs/whatsapp-bridge-install.log`.
