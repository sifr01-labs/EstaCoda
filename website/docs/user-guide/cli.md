---
title: CLI
description: Interactive CLI, sessions, slash commands, and terminal behavior for v0.1.0.
sidebar_position: 1
---

# CLI

The CLI is the supported direct interaction surface for EstaCoda. It runs an interactive terminal session, executes one-shot commands, and exposes operational controls for setup, inspection, and recovery.

This page explains how the CLI behaves, what it renders, and where it fails.

---

## What the CLI Is

`estacoda` without arguments starts an interactive session. The session loop reads input, dispatches to the runtime, and renders output through a terminal-native pipeline.

The CLI is not a chat wrapper. It is a stateful agent command surface with explicit sessions, profile boundaries, approval prompts, and rendering contracts.

---

## Starting and Resuming

```bash
# Start a fresh interactive session
estacoda

# Continue the last CLI session for this profile and workspace
estacoda --continue
# Short form
estacoda -c

# Choose a different resumable session
estacoda sessions

# Resume a known session by id
estacoda sessions open <session-id>

# Run a one-shot command
estacoda --profile work "explain this file"

# Select a profile for this command only
estacoda --profile work model status
estacoda -p work doctor
```

`--profile` / `-p` selects a profile for the current command only. It does not change the active profile on disk. Only `estacoda profile use <name>` updates `~/.estacoda/active-profile.json`.

Every CLI invocation that reaches the runtime starts a fresh session by default. Continuation is explicit: `--continue` / `-c` uses the last CLI session pointer for the selected profile and current workspace, while `estacoda sessions` opens the session picker and `estacoda sessions open <session-id>` resumes a known session directly. All three paths still run normal setup and workspace-trust checks.

The `--continue` / `-c` flag also works with a one-shot prompt or slash command. It is rejected with standalone operator commands that dispatch before a conversational runtime. If the scoped pointer is missing, malformed, empty, ended, internal, or belongs to another profile or workspace, startup fails closed and suggests `estacoda sessions`.

---

## Setup and Verification

```bash
estacoda setup              # Canonical setup entrypoint
estacoda verify             # Verify configuration
estacoda verify vision      # Prove the configured local vision route
estacoda settings           # Show current settings
estacoda doctor             # Health report and required fixes
estacoda doctor --live      # Live provider check
```

`estacoda setup` is the canonical setup entrypoint. Bare `estacoda` launch routes to setup when configuration is incomplete.

New users enter the Onboarding Wizard. The visible flow is setup detection, profile bootstrap, welcome, language/style, workspace, workspace trust, model route, safety, Agent Evolution, optional capabilities, summary, apply, and launch. Normal users see `summary -> confirm -> apply -> verify`; the redacted manifest and apply plan are internal/operator-inspectable.

Setup is reviewed, not autonomous. No wizard step writes or serializes raw secrets; cancellation and blocked apply paths write nothing. Credentials are displayed only as `Not set`, `Existing credential detected`, or `New credential pending`. Reviewed apply execution is the only boundary that persists secrets to the selected profile `.env` with `0600` permissions. Raw secrets are not displayed in review output.

The Onboarding Wizard optional capability menu covers Channels, Voice STT/TTS, Browser, and Skip. Vision & Images is configured from the Setup Editor, not from the Onboarding Wizard. Open **Vision & Images** and choose **Vision Analysis** or **Image Generation & Editing**. The image-generation flow is unchanged. Vision Analysis is no longer listed under Auxiliary models; its common screen offers Automatic, Choose a vision model, and Turn off, with main-only routing and dedicated-with-main-fallback under Advanced settings.

Advanced Vision Analysis settings contain hosted-processing preference, request timeout, and concurrency. They control routing/privacy and simultaneous provider work, not how many submitted images are analyzed; image sets up to twenty are handled automatically in bounded batches. `local-only` blocks hosted image processing; `allow-with-approval` keeps contextual runtime approval in force. Cancelling review writes no route or credential changes. After apply, the Setup Editor offers a bundled benign English/Arabic verification and defaults to skipping it. Hosted verification requires a second explicit image-egress and possible-cost consent; declining sends nothing. The equivalent commands are `estacoda verify vision` for an all-local route and `estacoda verify vision --consent-hosted` when the selected route or a possible fallback is hosted. Verification reports route, dispatch, credential and vision readiness, text detection, normalized size, latency, approximate cost, fallback, and non-secret fingerprints without rewriting config, secrets, or expiring OAuth state.

Workspace trust is required before EstaCoda can run in a workspace. If trust is deferred, setup may be saved, but launch is blocked with `Setup saved. Workspace trust is still required before EstaCoda can run here.`

`Start EstaCoda now?` is a post-success prompt after apply and verification. A yes answer reloads the selected profile config, reloads trust state, verifies workspace trust, rebuilds runtime from fresh config, and enters the normal interactive launcher.

Existing users who run the Setup Editor get a different post-apply path. The final review prompt is titled `Finalize configuration`, shows `Confirm selected configuration`, and includes a dynamic selected area such as `Channels · Telegram` or `Security`. `Confirm` updates the selected profile configuration. `Cancel` keeps the existing configuration unchanged and writes no config or secret changes. The technical review manifest remains internal and is not printed as user-facing setup output.

The Setup Editor has one `Budgets` entry for optional estimated provider-spending limits. Open it to choose the default Task or session limit; each setting shows `Off` or its configured USD amount and has its own review/apply step. Applying one returns to the refreshed Budgets submenu without changing the other. Limits are Off by default, while `$0.00` is an enabled zero-spend policy. See [Configuration](../reference/configuration.md#budgets) for scope and enforcement details.

After an existing-user Setup Editor apply, EstaCoda reports the apply and verification result and exits the setup flow. It does not show `Setup next action`, does not output `Selected: Launch EstaCoda`, and does not hand off to `Launch EstaCoda`. First-run onboarding still owns the launch prompt after verified setup.

The Setup Editor exposes `EstaCoda Doctor` as the read-only health action. Use it when you want setup health, required fixes, and provider route status without changing configuration. See [Doctor](./doctor.md) for the full command behavior and repair flags.

---

## Trace and Eval

```bash
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>
```

- `list` shows recent trajectories with session IDs and outcomes.
- `dump` outputs full JSON, redacted by default.
- `timeline` outputs chronological human-readable events.
- `failures` lists classified failures for a trajectory.
- `--raw` bypasses redaction. Use with care.

```bash
estacoda eval [fixture-id]
```

Runs deterministic eval fixtures and returns pass/fail per assertion with timing.

---

## Session Navigation, Recall, and Compaction

```bash
estacoda sessions
estacoda sessions open <session-id>
estacoda session recall <query>
estacoda sessions recall <query>
estacoda sessions compact <session-id> [--topic <topic>]
```

In a TTY, `estacoda sessions` displays up to 20 active user-facing root sessions with user activity from the selected profile and current workspace. The rows show a safe description; the focused row adds start time, last activity, and immutable origin surface. Enter resumes the selected session and Escape cancels without changing the active session.

Recall commands summarize historical session matches. They use the selected profile, apply workspace scoping when a workspace root is available, and fall back to deterministic snippets if auxiliary summarization fails.

`sessions compact` calls semantic session compression for a target session. It is non-rotating in this implementation; it does not create or adopt a compacted child session.

---

## Interactive Slash Commands

Inside an active session, slash commands provide operational controls. This is a high-level overview; the full inventory lives in the reference documentation.

| Command | Purpose |
|---------|---------|
| `/sessions` | Choose another resumable session in an interactive CLI; list sessions on non-picker surfaces |
| `/search <query>` | Search session history |
| `/session recall <query>` | Summarize historical session matches |
| `/compact [topic]` | Compact in-session context |
| `/model` | Show ready/runnable model choices |
| `/model <provider>/<model>` | Set a session-scoped model override |
| `/model clear` | Clear the session-scoped model override |
| `/switch <session-id>` | Switch to another session |
| `/reset` | Start a fresh session |
| `/trust` | Show workspace trust status |
| `/yolo` | Toggle open approval mode |
| `/skills` | List visible skills |
| `/tools` | List available tools |
| `/security` | Show recent security decisions |
| `/security debug` | Detailed security audit |
| `/cron` | List scheduled tasks |
| `/approvals` | Show current approvals |
| `/revoke <approval-id>` | Revoke a persistent approval |
| `/reload-mcp` | Reload MCP servers |
| `/exit` | Exit session |

`/model` is session-scoped by default. `/model --global <provider>/<model>` persists the route as the profile primary model after trust checks. `/model --global clear` is rejected; use `estacoda model setup` for primary route management.

The interactive `/model` picker labels the two choice screens `Select provider` and `Select model`. Both screens use session-only wording: `Select the provider to use for this session only.` and `Select the model to use for this session only.`

After a session override, the CLI prints a compact notice and does not replay the startup dashboard:

```text
Model: deepseek-v4-flash
Session model override set: deepseek/deepseek-v4-flash
Scope: session
Fallback routes unchanged.
```

Plain, CI, and non-TTY output remains unstyled. Interactive terminals that support standard styling may bold notice labels.

---

## Operator Console And Active-Turn Controls

Papyrus is the terminal UI substrate. The Operator Console is the live
interactive CLI frame built on Papyrus and enabled by default for supported TTY
sessions. The session loop, setup flows, and raw prompt input send semantic
state to `OperatorConsoleRuntimeHost`; Papyrus lays out and renders the frame,
and the raw prompt render loop applies only terminal diff/cursor cleanup.

The live TTY frame is composed from these surfaces:

- startup dashboard
- live assistant streaming
- approvals
- active work
- queued steer
- retained durable Task cards and modal Task inspection
- attachments
- prompt / steer input
- slash menu
- status rail
- setup/select panels where applicable

The persistent status rail contains only model, context usage/bar, and session
timer. Tools, approvals, workspace/trust, setup, steering, channel state, and
active-turn noise render in contextual surfaces, not in the rail.

Context usage is the last input-token count reported by the provider for the
active session. EstaCoda holds it across turns and usage-less responses instead
of replacing it with estimates. `--/total` means no current provider measurement
is available yet, including immediately after compaction or a model change.

During supported interactive TTY turns, visible provider text streams inside the
Operator Console as a live preview. When the turn completes, the live frame is
cleared and the finalized assistant response is printed through the durable
assistant renderer so long answers are not clipped by the live frame. Plain,
CI, and non-TTY sessions keep append-only stdout streaming.

Slash autocomplete renders as an Operator Console menu below the prompt and
above the status rail. Paste references render as attachment cards above the
prompt; full pasted content is stored for submission and is not dumped into
prompt chrome. Active work is uncapped in model storage and viewport-limited in
rendering. Approval cards emit approve/reject/inspect intent only; approval and
security policy remain authoritative.

Durable Tasks linked to the active session remain visible as cards after their
creating turn and after terminal settlement. Use `Ctrl+T` or an available `Tab`
transition to focus them, arrow keys to select a Task, and `Enter` to inspect.
On a focused Task, press `T` to enter its logical activity trace; use
`Left`/`Right` or `Home`/`End` to inspect history or return live, `Enter` to open
the selected activity, and `Escape` to collapse the trace. The control row shows
only actions valid for the current state: `R` retry, `D` detach, `P` pause, and
`C` cancel with confirmation. Settled Tasks retain trace inspection without
showing mutation controls.
The inspection page supports arrow scrolling, `Page Up`/`Page Down`,
`Home`/`End`, and `Escape` to return. It shows bounded plan, Step, Attempt,
elapsed-time, safe-activity, tool-category, usage/cost, result-handle, and
wait/failure metadata. It does not show raw worker text, provider streams, raw
event payloads, tool arguments/results, credentials, private paths, or result
bodies. Plain, CI, dumb-terminal, and non-TTY sessions use the deterministic
`task` and `/task` command output instead.

When the Task delivers its answer, the final compact activity ribbon remains
visible immediately above that answer. It records execution history and terminal
outcome, not completion percentage; degraded runs retain their warning and
worker-outcome summary.

Input ownership is deterministic: modal Task inspection, then approval prompts,
then autocomplete/typeahead, then attachment selection, then ordinary prompt or
steering input.

Bracketed paste is enabled only for supported TTY prompts. Small single-line
pastes remain inline. Multiline and large pastes become attachment cards. Secret
prompts bypass paste preview/storage and do not emit shortcut hints or live
slash hints.

Arabic setup chrome is direction-aware for localized setup selectors, rails, onboarding summaries, prompt cards, raw setup prompts, verification reports, and the startup dashboard. Arabic picker rows are RTL/right-aligned, selected output uses `تم تحديد`, and technical selected values are LTR-isolated. The Arabic startup dashboard uses two RTL-aware columns at normal widths and a bounded stacked layout at narrow widths. This is not full runtime Arabic localization.

Onboarding provider credential prompts and Telegram token prompts share setup editor prompt copy. Arabic display strings isolate technical tokens, while stored config, env, auth, and state values remain raw. Secret prompts remain masked.

After a normal message is submitted, the idle prompt is gone. The active turn
shows durable transcript output plus Operator Console active-work, approval, and
steer surfaces. It does not show a fake read-only prompt box containing the
submitted user text.

While EstaCoda is responding, typing opens `Steer current turn`. Non-empty steer
text writes a transcript-visible `User steer:` block, aborts the current CLI turn
with `CLI steer`, and queues one retry with the original submitted text plus an
explicit steering note. Empty or whitespace-only steer input does nothing.
`Esc` cancels a steer draft or queued steer. `Ctrl+C` remains the hard interrupt
path: the first press cancels the active turn, and a second press exits the
session if the turn has not settled. Entering an exact `/exit` in the active
steer surface also exits immediately instead of queueing a steer. These exit
paths are not modeled as steer submit/cancel.

---

## Approval Prompts

When a tool execution reaches an approval gate, the CLI accepts these bare answers:

- `once` — grant this exact action one time.
- `session` — grant matching actions for the current session.
- `always` — persist a workspace approval for matching actions.
- `deny`, `reject`, `no`, `n` — deny the action without retry.

Slash-style aliases are also accepted inside the prompt:

- `/approve once`
- `/approve session`
- `/approve always`
- `/deny`

These normalize into the same grant path. Invalid input such as `/approve banana` follows the invalid-answer guidance path and does not grant approval.

---

## Rendering and Terminal Behavior

CLI output flows through a three-stage pipeline:

```text
Runtime Data → ViewModel → Renderer → Output
```

Two renderers exist:

| Renderer | Mode | ANSI | Unicode | Emoji | Animation |
|----------|------|------|---------|-------|-----------|
| Plain | `plain` | No | No | No | No |
| Standard | `standard` | Yes | Yes | Skin-controlled | Capability-gated |

Plain mode is chosen when any of the following is true:
- `--plain` flag
- Not a TTY
- CI environment
- `TERM=dumb`
- Color unsupported

Standard mode requires TTY, color support, non-CI, and non-dumb terminal.

Environment variables that affect rendering:

| Variable | Effect |
|----------|--------|
| `NO_COLOR` | Disables all ANSI color |
| `FORCE_COLOR` | Overrides color detection |
| `TERM=dumb` | Disables color and animation |
| `COLUMNS` | Overrides terminal width |
| `ESTACODA_THEME` | `light` or `dark` |
| `ESTACODA_MODE` | `plain` or `standard` |
| `ESTACODA_SKIN` | `kemetBlue` |

Standard mode uses Unicode box-drawing and a small semantic motion language: Braille for waits, soft arcs for thinking, chevrons for routing, quarter turns for tools, pulses for delegated workers, diamonds for finalizing, and an orbit for background maintenance. Each motion has its own theme color and cadence. Approval, queued, success, failure, cancellation, and blocked states remain static. Plain mode uses non-animated ASCII markers and semantic text labels.

---

## Failure Modes

**Missing config:** `estacoda` routes to setup. Run `estacoda setup` to repair.

**Provider not configured:** The runtime reports a broken route. Run `estacoda model setup` or `estacoda doctor --live` to diagnose.

**Approval required:** The Papyrus card initially selects **Inspect**; move explicitly to **Approve once** or **Reject** when ready. Explicit `/approve once|session|always` and `/deny` commands remain available for queued approvals. Check `/approvals` for current grants, and use `/revoke <id>` to remove a persistent grant.

**Unsafe command denied:** The command matched a hardline block. Change the command; the hardline floor cannot be overridden.

**Terminal/rendering limitations:** Plain mode falls back automatically. If output looks wrong, check `TERM`, `NO_COLOR`, and terminal width.

---

## Inspection and Recovery

```bash
# Current settings and model status
estacoda settings
estacoda model status

# Security decisions
/security
/security debug

# Session state
/sessions
/switch <session-id>
estacoda --continue
estacoda sessions open <session-id>

# Approval state
/approvals

# Gateway readiness
estacoda gateway diagnose
```

---

## Related

- [Sessions](./sessions.md) — session lifecycle and state ownership
- [Profiles](./profiles.md) — profile boundaries and switching
- [Tools](./tools.md) — tool execution and availability
- [Security and Approvals](./security-and-approvals.md) — approval modes and the hardline floor
