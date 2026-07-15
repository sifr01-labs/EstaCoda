---
title: "Operator Console"
description: "Papyrus-owned interactive CLI surface contract."
---

# Operator Console

This document is the surface contract for the EstaCoda Operator Console.

## Purpose

The EstaCoda Operator Console is the Papyrus-owned live interactive CLI frame.
Production interactive `estacoda` launches enable it by default for supported
TTY sessions. It owns the prompt, status rail, slash menu, attachment cards,
active work, approvals, steering, startup dashboard, and setup/select panels
where applicable.

Papyrus is the terminal UI substrate. The Operator Console is the product frame
built on top of that substrate. The session loop and setup/input controllers
emit semantic state and events; they do not patch terminal rows around prompt
implementation details.

```text
session/runtime/setup/input events
-> OperatorConsoleRuntimeHost
-> OperatorConsoleState
-> Operator Console surfaces
-> Papyrus layout/renderer
-> terminal diff adapter
```

Core rules:

- Papyrus owns pixels.
- Runtime owns meaning.
- Security policy remains authoritative.
- No session-loop ANSI surgery or terminal row ownership.
- UI components collect user intent; they do not grant permissions, mutate
  trust, or bypass policy.

## Ownership Model

The console splits responsibility across three layers:

| Layer | Owns | Must Not Own |
|------|------|--------------|
| Runtime/session/setup/input | messages, runtime events, tool activity, approval requests, prompt text, setup/select choices, model/context state | terminal row accounting or ANSI cursor patches |
| `OperatorConsoleRuntimeHost` | persistent live console state updates and deterministic frame rendering | stdout/stderr writes or security decisions |
| `OperatorConsoleState` | focus, surface ordering, prompt/attachment/tool/approval/steer/startup/setup UI state | provider routing, approval grants, workspace trust |
| Papyrus layout/renderer | measurement, wrapping, truncation, bidi-safe terminal layout, surface composition | security decisions or runtime semantics |
| Raw prompt render loop | terminal diff/write/cursor cleanup adapter | prompt/status/slash/attachment frame construction |

## Surface Order

The live console must support this vertical order:

```text
startup/transcript
live assistant streaming, if present
approvals, if present
active work, if present
queued steer, if present
attachments, if present
prompt / steer input
slash menu, if present
status rail
setup/select panels where applicable
```

The persistent status rail contains only:

- model
- context usage / context bar
- session timer

Tools, approvals, attachments, steering, workspace/trust, setup state, channel
state, and active-turn noise must not be added to the persistent rail. They get
contextual surfaces.

## State Model Sketch

These TypeScript shapes are intended contracts and may be refined during
implementation.

```ts
type OperatorConsoleState = {
  transcript: TranscriptBlock[];
  startup?: StartupDashboardState;
  prompt: PromptSurfaceState;
  status: StatusRailState;
  attachments: AttachmentCardState[];
  streaming?: StreamingState;
  activeWork: ToolActivityState;
  approvals: ApprovalCardState[];
  slash?: SlashMenuState;
  steer?: SteerState;
  setup?: SetupPanelState;
  focus: FocusState;
  terminal: TerminalMetrics;
};
```

## Focus And Event Boundary Sketch

```ts
type FocusTarget =
  | { kind: "prompt" }
  | { kind: "attachment"; attachmentId: string }
  | { kind: "activeWork"; toolEventId: string }
  | { kind: "approval"; approvalId: string; control: "approve" | "reject" | "inspect" }
  | { kind: "slashMenu"; itemId: string }
  | { kind: "steer" }
  | { kind: "setup"; controlId: string };
```

```ts
type OperatorConsoleEvent =
  | { type: "key"; key: ParsedKeypress }
  | { type: "paste"; text: string }
  | { type: "resize"; width: number; height: number }
  | { type: "toolEvent"; event: ToolActivityEvent }
  | { type: "approvalRequested"; request: ApprovalRequestViewModel }
  | { type: "turnStarted" }
  | { type: "turnCompleted" }
  | { type: "statusChanged"; status: StatusRailState };
```

Focus rules locked for v1:

- `Enter` submits the prompt.
- `Alt+Enter` inserts a newline.
- Paste preserves newlines.
- `Tab` and `Shift+Tab` move focus between prompt and attachment cards.
- `Enter` opens an attachment preview only when attachment focus is active.
- `Esc` removes a focused attachment or cancels steer draft/queued steer.
- `Ctrl+C` remains the hard active-turn interrupt.

## Phase-Mapped Target Renders

These renders are visual targets, not exact string snapshots. Papyrus owns
measurement, wrapping, truncation, focus, resize behavior, and Arabic/bidi
safety.

### Phase A: Surface State

No user-facing render is required.

```text
session/runtime events
-> OperatorConsoleState
-> Papyrus surfaces
-> compositor
-> terminal diff
```

Visual order supported:

```text
startup/transcript
live assistant streaming, if present
active work, if present
queued steer, if present
attachments, if present
prompt / steer input
slash menu, if present
status rail
```

### Phase B: Startup Dashboard

Wide startup dashboard:

```text
                         EstaCoda
                     ⟡ SIFR01 ⟡
                 sovereign agentic infrastructure
────────────── v0.1.0  ☂ session 20ea8195 ──────────────
╭──────────────────────────────────────────────────────────────────────────────╮
│ ╭─ Session ──────────────────────────╮ ╭─ Commands ────────────────────────╮ │
│ │ model       kimi-k2.6 ◐             │ │ /tools     inspect tools           │ │
│ │ context     0 / 262k                │ │ /skills    loaded skills           │ │
│ │ workspace   verified                │ │ /model     active model route      │ │
│ │ security    open                    │ │ /status    runtime state           │ │
│ │ autonomy    autonomous              │ │ /setup     setup editor            │ │
│ ╰────────────────────────────────────╯ ╰───────────────────────────────────╯ │
│                                                                              │
│ Tips                                                                         │
│ Paste large context as attachments. Use /model to switch routes.              │
│ Approvals appear inline when an action needs permission.                      │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Prompt ─────────────────────────────────────────────────────────────────────╮
│ ›                                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
kimi-k2.6 ◐ │ ctx [▱▱▱▱▱▱▱▱▱▱] 0/262k 0% │ session 00:10
```

Narrow startup dashboard:

```text
                         EstaCoda
                     ⟡ SIFR01 ⟡
                 sovereign agentic infrastructure
v0.1.0 · session 20ea8195
╭────────────────────────────────────────────╮
│ ╭─ Session ──────────────────────────────╮ │
│ │ model       kimi-k2.6 ◐                 │ │
│ │ context     0 / 262k                    │ │
│ │ workspace   verified                    │ │
│ │ security    open                        │ │
│ ╰────────────────────────────────────────╯ │
│ ╭─ Commands ─────────────────────────────╮ │
│ │ /tools    inspect tools                 │ │
│ │ /skills   loaded skills                 │ │
│ │ /model    active model route            │ │
│ │ /status   runtime state                 │ │
│ ╰────────────────────────────────────────╯ │
│                                            │
│ Tips                                       │
│ Paste large context as attachments.        │
╰────────────────────────────────────────────╯
```

Implementation target:

- Header = identity.
- Outer border = startup seal.
- Inner left box = Session.
- Inner right box = Commands.
- Tips = plain text.
- Prompt/status rail = live command surface.

### Phase C: Prompt Box And Status Rail

Single-line prompt:

```text
╭─ Prompt ─────────────────────────────────────────────────────────────╮
│ › review the Papyrus rollout plan                                    │
╰──────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ session 01:12
```

Multiline prompt expansion:

```text
╭─ Prompt · multiline ─────────────────────────────────────────────────╮
│ › write a migration plan for:                                        │
│   - approval cards                                                   │
│   - pasted attachments                                               │
│   - tool activity                                                    │
╰──────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ session 01:12
```

Long multiline prompt with internal scroll:

```text
╭─ Prompt · multiline ─────────────────────────────────────────────────╮
│ › write a migration plan for the Papyrus console redesign             │
│   focusing on:                                                        │
│   - startup dashboard                                                 │
│   - prompt expansion                                                  │
│   - active work                                                       │
│   - approvals                                                         │
│   - steering                                                          │
│                                                                      │
│ 12 lines · ↑↓ scroll within prompt                                    │
╰──────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ session 01:12
```

Status rail degradation:

```text
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ session 01:12
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 7% │ session 01:12
kimi-k2.7 ● │ ctx 7% │ 01:12
kimi ● 7% 01:12
```

### Phase D: Attachments

Wide attachment row:

```text
Attachments
╭─ pasted text ─────────────╮ ╭─ file excerpt ────────────╮ ╭─ pasted text ─────────────╮
│ MVP known issue…          │ │ src/cli/session-loop.ts   │ │ Stack trace from setup…   │
│ 2,481 chars               │ │ 184 lines                 │ │ 918 chars                 │
╰───────────────────────────╯ ╰───────────────────────────╯ ╰───────────────────────────╯
╭─ Prompt ─────────────────────────────────────────────────────────────╮
│ › summarize this and turn it into a regression test                  │
╰──────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 7% │ session 01:12
```

Narrow attachment layout:

```text
Attachments
╭─ pasted text ─────────────────────────────╮
│ MVP known issue…                           │
│ 2,481 chars · Enter open · Esc remove      │
╰────────────────────────────────────────────╯
╭─ file excerpt ────────────────────────────╮
│ src/runtime/provider-turn-loop.ts          │
│ 184 lines · Enter open · Esc remove        │
╰────────────────────────────────────────────╯
╭─ Prompt ──────────────────────────────────╮
│ › summarize this                           │
╰────────────────────────────────────────────╯
kimi-k2.7 ● │ ctx 7% │ 01:12
```

Submitted transcript form:

```text
User:
summarize this and turn it into a regression test
Attachments:
- pasted text · 2,481 chars
- file excerpt · src/cli/session-loop.ts · 184 lines
```

### Phase E: Delegated Active Work

Normal tool activity remains in the compact turn status while work is live. A
running `delegate_task` is the exception: its bounded child rows use the active
work region so the operator can see that isolated subagents are still running.

```text
Delegated work · 2 active · 1 done · 00:53
╭─ • Worker 1 · inspect delegation ───────╮  ╭─ ● Worker 2 · inspect tools ───────────╮
│ ✓ Search Files  src/delegation           │  │ · Read File  src/tools/delegation...   │
│ · Read File     progress-relay.ts        │  │                                         │
│                                         │  │                                         │
│                                         │  │                                         │
│                                         │  │                                         │
│                                         │  │                                         │
├─────────────────────────────────────────┤  ├─────────────────────────────────────────┤
│ running · 2 activities · 00:53          │  │ running · 1 activity · 00:53           │
╰─────────────────────────────────────────╯  ╰─────────────────────────────────────────╯
╭─ ✓ Worker 3 · inspect docs ─────────────╮
│ ✓ Search Files  docs/**/*delegation*     │
│                                         │
│                                         │
│                                         │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│ completed · 1 activity · 00:47          │
╰─────────────────────────────────────────╯
╭─ Prompt ─────────────────────────────────────────────────────────────╮
│ ›                                                                     │
╰──────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 7% │ session 01:12
```

Assistant prose emitted before `delegate_task` remains visible above the
delegated-work region. When the parent delegation settles, or a new live
assistant tail begins streaming, the child rows leave the live frame. The
durable turn-end surface keeps one parent tool row with the bounded outcome
counts:

Each worker card keeps a rolling maximum of six bounded activity rows. Cards
render two per row when two minimum-width cards fit and stack on narrower
terminals. At most three cards are visible: active workers take precedence and
recent completions fill remaining slots, while the header reports aggregate
active, completed, failed, and not-yet-observed queue counts for the whole
batch. Constrained layouts reduce activity rows before falling back to compact
worker lines. Running workers use the phase-shifted `worker` pulse token; plain
mode uses a stable ASCII marker with animation disabled. Worker timers begin
when each child starts, completion recency follows settlement time, and card
footers preserve distinct completed, blocked, failed, timed-out, and cancelled
outcomes.

```text
╭─ Tools completed ─────────────────────────────────────────────────────╮
│ ✗ Delegate Task    1 completed · 1 timed out · 1 failed        00:10  │
╰───────────────────────────────────────────────────────────────────────╯
```

Child prompts, transcripts, raw tool arguments, provider/model identifiers,
cancellation reasons, and child session identifiers are not rendered. Plain and
one-shot CLI modes emit at most two lifecycle lines per child, for example
`Worker 1: started` and `Worker 1: completed`; intermediate child
tool and provider events remain silent.

### Phase E2: Live Assistant Streaming

Live assistant streaming is the Operator Console view of visible provider text
while a local interactive CLI turn is in flight:

```text
User:
explain the setup editor flow
╭──────────────────────────── EstaCoda ────────────────────────────╮
│ The setup editor is split into detection, review, apply, and      │
│                                                                   │
│   ◷ read_file   src/cli/setup-editor.ts                    00:04 │
│                                                                   │
│ verification.▍                                                    │
╰───────────────────────────────────────────────────────────────────╯
╭─ Active work ─────────────────────────────────────────────────────────╮
│ ◷ reading setup editor files                                   00:04  │
╰───────────────────────────────────────────────────────────────────────╯
╭─ Steer current turn ──────────────────────────────────────────────────╮
│ ›                                                                      │
╰───────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 7% │ session 00:31
```

Streaming contract:

- Provider-layer reasoning filtering is authoritative. Reasoning fragments,
  hidden chain-of-thought, and provider-only control text must be filtered before
  any delta reaches the Operator Console.
- Papyrus consumes visible deltas only. The streaming surface must not parse,
  infer, recover, or render hidden reasoning from provider events.
- Live streaming and settled assistant responses share the same EstaCoda
  assistant-message frame language. User-visible debug chrome such as
  `Assistant stream` or `assistant:` must not appear in normal rendering. The
  live-only marker is the trailing cursor on incomplete text.
- Inline tool trails render inside that shared assistant-message frame using
  the Papyrus active-work visual grammar for status symbols. They are part of
  the assistant answer surface, not a detached dashboard or separate transcript
  role.
- Local interactive Operator Console turns receive visible text through
  `runtime.handle({ onDelta })`. Plain CLI turns keep the append-only stdout
  `provider-token` path and must not be converted to managed-frame rendering.
- `onSegmentBreak` is tool-boundary-only in this pass. It seals the current
  visible assistant segment before tool progress appears; it is not a general
  markdown, paragraph, or reasoning delimiter.
- Streaming state may carry `toolTrail` metadata derived from active-work
  events. The metadata preserves tool identity, status, timing, and the
  assistant segment it follows; the frame renderer displays that trail inline
  between the segment it follows and later assistant text when possible.
- Inline trail rendering is passive: it formats the current trail metadata and
  does not add optional progress plumbing or independent live duration ticks.
- If a provider attempt reports `provider-result.willFallback`, the Operator
  Console resets live streaming for that attempt before fallback output starts.
  Failed-attempt text must not survive into the visible fallback stream.
- Final assistant response dedupe depends on non-empty visible streaming output:
  `tail.trim().length > 0 || segments.some((segment) => segment.text.trim().length > 0)`.
  Whitespace-only or fully filtered streams still render the finalized assistant
  response normally.
- The streaming layout priority is `STREAMING_PRIORITY = 5`. It sits above
  transcript (`TRANSCRIPT_PRIORITY = 6`) and below higher-priority interactive
  surfaces such as active work, approvals, prompt, slash, and status. Constrained
  terminals may hide streaming before those interactive/status surfaces.
- Raw prompt frame rebuilds must restore streaming after `host.clear()`. The
  ordering is part of the contract because `clear()` removes transient host
  state before the snapshot is replayed into the new frame.
- CLI streaming settlement is atomic: clear the live frame, discard live
  streaming state without redrawing it as a height-constrained transcript
  surface, stop the streaming refresh timer, and print the finalized assistant
  response through the durable assistant renderer. This keeps final answers in
  scrollback and avoids clipping them to live-frame height.
- Streaming refreshes share the Operator Console refresh path with animation
  ticks. Back-to-back timer wakeups should be coalesced or dropped rather than
  fighting over terminal writes.

### Phase F: Inline Approval Cards

Approval required:

```text
Assistant:
I need approval before modifying the database.
┌─ Approval required ───────────────────┐
│ Action: run migration                  │
│ Target: production database            │
│ Risk: schema change                    │
│                                        │
│ [Approve once]   [Reject]   [Inspect]  │
└────────────────────────────────────────┘
Assistant:
Waiting for approval.
```

Focused approval control:

```text
┌─ Approval required ─────────────────────────────────────┐
│ Action: write file                                      │
│ Target: src/runtime/provider-turn-loop.ts               │
│ Risk: runtime behavior change                           │
│                                                         │
│ +42 lines  -17 lines                                    │
│                                                         │
│ ❯ Approve once        Reject        Inspect             │
└─────────────────────────────────────────────────────────┘
```

Approval v1 controls:

- Approve once
- Reject
- Inspect

Feedback, amend, session approval, and persistent approval controls are out of
scope for approval v1 unless the implementation adds a separately reviewed
runtime path.

### Phase G: Setup And Secret Panels

Provider/model table:

```text
╭─ Model route ─────────────────────────────────────────────────────────╮
│ Choose the active provider and model route.                           │
│                                                                       │
│ Provider        Model                    Status        Notes          │
│ ───────────────────────────────────────────────────────────────────── │
│ ❯ OpenAI        gpt-5.5                  ready         API key set     │
│   Anthropic     claude-sonnet-4.5        ready         API key set     │
│   Local         qwen3-coder              offline       endpoint unset  │
│   Z.AI          glm-4.5                  ready         API key set     │
│                                                                       │
│ ↑↓ navigate · Enter select · / filter · Esc back                      │
╰───────────────────────────────────────────────────────────────────────╯
```

Secret entry:

```text
╭─ API key · OpenAI ────────────────────────────────────────────────────╮
│ Enter API key for OpenAI.                                             │
│                                                                       │
│ sk-••••••••••••••••••••••••••••••••                                  │
│                                                                       │
│ Stored as: OPENAI_API_KEY                                             │
│                                                                       │
│ Enter save · Esc back · Ctrl+C exit                                   │
╰───────────────────────────────────────────────────────────────────────╯
```

Secret rules:

- Never render raw secrets after input.
- Never preview secret paste.
- Never store secret values in transcript.
- Mask by terminal cell count.
- Destroy secret state after save/cancel.

### Phase H: Slash Menu

```text
╭─ Prompt ─────────────────────────────────────────────────────────────╮
│ › /mo                                                                │
╰──────────────────────────────────────────────────────────────────────╯
╭─ Commands ───────────────────────────────────────────────────────────╮
│ ❯ /model        show or change active model route                    │
│   /model setup  configure provider/model credentials                 │
│   /model list   list available models                                │
╰──────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 7% │ session 00:13
```

Slash suggestions are anchored to prompt input. The command registry remains
semantic; the Operator Console renders the slash menu below the prompt and above
the status rail. It is not inserted as raw prompt overlay rows.

### Phase I: Steering And Interrupt

Active turn with steer draft:

```text
Assistant is working…
╭─ Active work ─────────────────────────────────────────────────────────╮
│ ◷ reading setup editor files                                   00:08  │
│ ◷ searching approval tests                                      00:04  │
╰───────────────────────────────────────────────────────────────────────╯
╭─ Steer current turn ──────────────────────────────────────────────────╮
│ › focus only on approval cards and pasted attachments                  │
╰───────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 7% │ session 00:31
```

Queued steer:

```text
Assistant is working…
╭─ Active work ─────────────────────────────────────────────────────────╮
│ ◷ terminal.exec     pnpm test                                  00:31  │
│ ◷ read_file         src/cli/session-loop.ts                    00:08  │
╰───────────────────────────────────────────────────────────────────────╯
╭─ Queued steer ────────────────────────────────────────────────────────╮
│ focus only on approval cards and pasted attachments                    │
│ Will apply at next safe boundary · Esc cancel                          │
╰───────────────────────────────────────────────────────────────────────╯
╭─ Steer current turn ──────────────────────────────────────────────────╮
│ ›                                                                      │
╰───────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 7% │ session 00:31
```

Steering semantics:

- Typing during active turn opens `Steer current turn`.
- `Enter` submits steer.
- Runtime applies steer at the next safe boundary.
- Queued steer card appears until applied/cancelled.
- One queued steer exists at a time.
- `Esc` cancels draft or queued steer.
- `Ctrl+C` interrupts the active turn.
- A second `Ctrl+C` exits according to the active session policy.

### Phase J: Full Live Session Composite

```text
User:
review the Papyrus rollout plan
Assistant:
The structure is sound. The critical change is that Papyrus owns the interactive
frame while runtime and setup code send semantic state into the Operator Console.
╭─ Active work ─────────────────────────────────────────────────────────╮
│ ✓ searched operator console files                              00:01  │
│ ◷ reading setup editor tests                                   00:04  │
╰───────────────────────────────────────────────────────────────────────╯
Attachments
╭─ pasted text ─────────────╮ ╭─ file excerpt ────────────╮
│ MVP known issue…          │ │ src/cli/session-loop.ts   │
│ 2,481 chars               │ │ 184 lines                 │
╰───────────────────────────╯ ╰───────────────────────────╯
╭─ Prompt ─────────────────────────────────────────────────────────────╮
│ › focus next on approval cards and steering                          │
╰──────────────────────────────────────────────────────────────────────╯
kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ session 01:12
```

## Current Source Responsibility Map

| Area | Files |
|------|-------|
| Runtime host and state | `src/ui/papyrus/operator-console/operatorConsoleRuntimeHost.ts`, `src/ui/papyrus/operator-console/operatorConsoleState.ts` |
| Layout and deterministic text render | `src/ui/papyrus/operator-console/operatorConsoleLayout.ts`, `src/ui/papyrus/operator-console/operatorConsoleRenderer.ts` |
| Prompt/status surfaces | `src/ui/papyrus/operator-console/promptSurface.ts`, `src/ui/papyrus/operator-console/statusRailSurface.ts` |
| Live assistant streaming | `src/ui/papyrus/operator-console/assistantMessageFrame.ts`, `src/ui/papyrus/operator-console/streamingSurface.ts`, `src/ui/papyrus/operator-console/activeWorkRuntimeMapper.ts`, `src/cli/live-operator-console-controller.ts`, `src/cli/session-loop.ts` |
| Settled assistant transcript frame | `src/ui/papyrus/operator-console/assistantMessageFrame.ts`, `src/ui/papyrus/operator-console/transcriptSurface.ts` |
| Active work | `src/ui/papyrus/operator-console/activeWorkSurface.ts`, `src/ui/papyrus/operator-console/activeWorkRuntimeMapper.ts` |
| Approvals | `src/ui/papyrus/operator-console/approvalSurface.ts`, `src/ui/papyrus/operator-console/approvalRuntimeMapper.ts` |
| Steering | `src/ui/papyrus/operator-console/steerSurface.ts` |
| Attachments | `src/ui/papyrus/operator-console/attachmentSurface.ts` |
| Slash menu | `src/ui/papyrus/operator-console/slashSurface.ts` |
| Startup dashboard | `src/ui/papyrus/operator-console/startupDashboardSurface.ts`, `src/ui/papyrus/operator-console/startupRuntimeMapper.ts` |
| Setup/select panels | `src/ui/papyrus/operator-console/setupPanelSurface.ts`, `src/ui/papyrus/operator-console/setupSelectRuntimeMapper.ts`, `src/cli/interactive-select.ts` |
| Session integration | `src/cli/session-loop.ts`, `src/cli/create-interactive-prompt.ts`, `src/cli/rawPromptController.ts`, `src/cli/rawPromptRenderLoop.ts` |

`src/cli/rawPromptRenderLoop.ts` is now a terminal diff adapter. It may write
cursor movement and clear-line escape sequences as part of the managed TTY
adapter, but it does not own prompt/status/slash/attachment composition.

## Removed Legacy Pieces

The live interactive CLI no longer uses the removed bottom-region controller,
the removed active-turn command controller, fixed live tool slots, spinner
tickers, the exported prompt-only raw frame builder, or the old interactive
prompt implementation.

Operational docs must not point contributors to removed implementation files.
Historical notes may mention the migration only when clearly labeled as history.

Do not reintroduce:

- session-loop terminal row surgery;
- raw slash menu insertion above a status rail;
- tool activity caps in the live active-work model;
- approval controls that grant permission directly from UI state;
- steering paths that treat `Ctrl+C` as steer submit/cancel;
- workspace/trust/setup/tool/approval/steer/channel data in the persistent rail.

## Failure, Debug, And Audit Guidance

- State mapping problems usually start in the runtime mappers under
  `src/ui/papyrus/operator-console/*RuntimeMapper.ts` or the session integration
  in `src/cli/session-loop.ts`.
- Surface rendering problems usually start in the specific `*Surface.ts` file,
  `operatorConsoleLayout.ts`, or `operatorConsoleRenderer.ts`.
- Terminal write/cursor cleanup problems are isolated to
  `src/cli/rawPromptRenderLoop.ts`.
- Prompt editing, paste, slash typeahead, and attachment submission behavior
  start in `src/cli/rawPromptController.ts`.
- Setup/select TTY shell routing starts in `src/cli/interactive-select.ts` and
  maps into Papyrus setup panels.
- Approval policy and grant behavior remain outside the UI. Inspect
  `src/cli/approval-prompt-adapter.ts` and `src/security/` before changing
  approval semantics.

## Validation Expectations

Full validation before shipping an implementation PR:

```bash
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
git diff --check
```
