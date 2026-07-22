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
- session cost
- session timer

Tools, approvals, attachments, steering, workspace/trust, setup state, channel
state, and active-turn noise must not be added to the persistent rail. They get
contextual surfaces.

Session cost is a projection of persisted canonical provider-request rows. The
rail prioritizes the cost segment over context detail in narrow layouts. It is
restored after restart and follows only verified transcript-compression
ancestry; an ordinary parent or delegated worker-session relationship does not
join session totals.

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
- Typing or using prompt-editing controls while a main-session Task/Subagent is
  focused returns focus to the prompt before applying the edit.

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
│ │ context     -- / 262k               │ │ /skills    loaded skills           │ │
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
kimi-k2.6 ◐ │ ctx [··········] --/262k --% │ session 00:10
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
│ │ context     -- / 262k                   │ │
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

### Phase E: Durable Task Creation

`delegate_task` is a short Task-creation operation in the active turn. It
persists a fixed graph and returns a bounded Task handle; it does not keep the
turn open while worker Steps execute. Running Attempts belong to the Task host
and use Task/background-work surfaces rather than nested child cards owned by
the creating tool row.

The completed turn retains the ordinary `delegate_task` row and its bounded
handle metadata. Task progress, approval waits, cancellation, result bodies,
and terminal settlement are sourced from the durable Task journal.

The delivered response also prints the durable Task handle and current bounded
status. As asynchronous work settles, its retained Task card and the current
session total refresh from persisted accounting; old assistant transcript
messages are not rewritten. Task cards use the same complete/lower-bound/
unavailable cost language as turns and never present missing pricing as zero.

Linked Tasks also render as retained Task cards in the interactive console.
The card footer and inspection projection distinguish Task lifecycle from live
foreground/background/waiting ownership, show the immutable preference and
background-continuation readiness, and include only a bounded safe wait reason.
Expired leases and Task status alone are never presented as active ownership.
Cards remain available after completion, failure, partial settlement, or
cancellation; they are not transient worker rows. The main-session Task region
shows stable `Subagent N` identities beneath the live assistant stream. Each
full Subagent card occupies exactly seven rows, including its title and truthful
status/elapsed/tokens/cost footer. The interior continually refreshes with the
latest retained safe activity. Cards use the elevated grey surface token,
whitespace gutters instead of permanent perimeter borders, and the existing
worker motion token while running. Focus adds the action-color leading rail and
title treatment.

One to three Subagents stack vertically. Four to six use two equal-width,
column-major columns when both remain readable. A third column is added only at
a readable width; otherwise the surface keeps complete seven-row cards and
shows `+N more Subagents`. Narrow and height-constrained terminals use the
single-column or compact deterministic fallback instead of clipping a card.
The Task header opens the whole-Task view; a Subagent card opens that Subagent.

The whole-Task inspection workspace shows the objective, lifecycle, elapsed
time, aggregate usage/cost, factual Step state, Subagent summaries, approvals,
blockers, dependencies, results, child Tasks, and safe artifacts. Its activity
trace is an event sequence, not a completion meter: one semantic-color square
per retained `Terminal`, `Search`, `Plan`, `Read`, `Edit`, `Answer`, `Wait`,
`Finish`, or `Failed` event, plus all-time category counters. The outlined
square is the inspected event; the separate live-tail marker is the newest
event. Selecting history disables follow-live and exposes `Return to live`.
Overflow uses a bounded readable window with an earlier-event count. The view
may state `N of M Steps settled`, but never derives or renders a Task completion
percentage. All-time counters come from profile-scoped aggregate metadata; the
projection does not load or expose omitted Event payloads.

Subagent inspection reuses the workspace filtered by stable Step ID. It shows
the Subagent objective, current safe activity, usage/cost, complete retained
safe trace, assistant preview/final result, retry Attempts, dependencies,
blockers, results, and artifacts. `Complete retained safe trace` does not mean
raw reasoning, raw prompts, credentials, tool arguments/results, or unbounded
provider text. The Results and artifacts section is limited to projected result
handles and summaries; it does not claim a separate file-access history.

`Tab` (when no higher-priority typeahead or attachment surface owns it) or
`Ctrl+T` focuses the Task header. `Up`/`Down` change Tasks, `Right` enters the
visible Subagent grid, and the arrow keys then move among complete visible
Subagent cards. `Enter` opens the focused Task header or opens a focused
Subagent directly. Native terminal selection, copy/paste, and scroll behavior
remains available by default. `Ctrl+G` explicitly enables temporary Mouse Mode
for the Task region; while active, Task/Subagent cards, breadcrumbs, trace
events, and `Return to live` use the same actions as their keyboard routes.
`Up`/`Down`, `Page Up`/`Page Down`,
`Home`, and `End` navigate or scroll according to the active inspection target;
`Escape` first releases an active Mouse Mode, then unwinds Subagent to Task to
main session without losing the underlying session state. Typing, pasting, or
using prompt-editing controls such as Backspace, Delete, and line-edit shortcuts,
clicking outside an interactive Task region, closing inspection, or losing the
Task region also releases Mouse Mode. Whole-Task selection adjusts scroll to
keep the selected Subagent visible. Wheel input scrolls only inside inspection
while Mouse Mode is active. Terminal startup defensively resets stale tracking,
and cleanup disables it on normal exit, failure, and suspend.

The existing Task refresh updates projections and newly settled provider usage
in place. Established cards retain their order, selected Task/Subagent/event
IDs remain selected while present, history remains frozen when follow-live is
off, and terminal resize recomputes the layout without closing inspection.

The inspection view reads only the session-authorized Task projection: bounded
objective and Step labels, status, plan revision, dependencies, active Attempt
metadata, elapsed time, whitelisted activity labels, coarse tool category,
usage/cost totals, opaque result handles, and bounded wait/failure classes. It
never reads raw session events, worker transcripts, provider token streams,
tool input/output, result bodies, workspace paths, credentials, lease-owner
identities, or unbounded child text.

Worker progress persists only categorical, bounded transition labels (for
example provider wait/fallback and tool category). Child Tasks appear only as
bounded handles, statuses, and parent-Attempt attribution. The originating
session receives an observer link at child creation; raw child prompts,
transcripts, and provider-token text remain excluded. Provider fallback text is
not buffered into Task cards or inspection. Consequently, abandoned text from
a failed provider route cannot remain visible as accepted worker output; the
Task result becomes readable only through the verified result surface after
settlement. Tool-call transitions update the safe activity checkpoint without
persisting tool arguments, previews, or result bodies.

For a completed synchronous turn, the active-work footer shows `Main agent`
and `Turn total`. When there is no completed-work card, the response receives a
compact `Turn cost` line. Multiple runtime turns caused by one CLI steering
submission are summed before the final visible response is delivered.

Interactive input precedence is centralized as: modal Task inspection,
approval prompt, autocomplete/typeahead, attachment selection, then ordinary
prompt or steering input. Plain, CI, dumb-terminal, and non-TTY Task inspection
continues through deterministic `task` and `/task` text commands without
animation, background paint, mouse dependence, or cursor-managed UI. Arabic
inspection isolates technical tokens such as Task IDs, Subagent labels, result
handles, costs, and counts so mixed-direction output remains readable.

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

## Semantic Motion

The live console uses one elapsed-time animation clock. Surfaces calculate their visible frame from the selected token's cadence and redraw only when that visible frame changes. There are no per-spinner timers.

| Runtime activity | Motion token |
|------------------|--------------|
| Provider or generic wait | `waiting` |
| Thinking | `thinking` |
| Intent routing | `routing` |
| Tool execution | `tool` |
| Delegated worker | `worker` |
| Finalizing | `finalizing` |
| Background maintenance | `background` |

Each token has its own frames, cadence, and theme-specific foreground color under `UiTokenContract.motion`. Approval, queued, success, failure, cancellation, and blocked states remain static status symbols. Plain, CI, dumb-terminal, and non-TTY paths remain non-animated and color-free.

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
