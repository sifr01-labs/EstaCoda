# Roadmap

This is the agent-facing roadmap snapshot. It mirrors the intent of [NEXT_PHASE_ROADMAP.md](/Users/ahnwy/estacoda-v2/NEXT_PHASE_ROADMAP.md) but is written for implementation handoff.

## Current Stage

EstaCoda v2 is in **strong internal alpha / pre-MVP hardening**.

It is already useful for:

- CLI provider-backed work `live-proven`
- skill-backed workflows `smoke-tested`
- Telegram text usage `live-proven`
- Telegram document analysis `live-proven`
- Telegram image understanding with Kimi `live-proven`
- repeatable internal alpha runs `live-proven`

Current hosted-provider matrix:

- Kimi: full pass `live-proven`
- OpenAI: full pass `live-proven`
- DeepSeek: full pass `live-proven`
- OpenRouter: runtime path works, exactness still partial `live-proven`
- local/Ollama: not accepted in this environment `live-proven`

It is not yet “ship broadly without caveats.”

## Milestone Status

### 1. Multi-step agent core

State: mostly strong.

Done:

- provider-backed read/write/edit flows `live-proven`
- recoverable tool-call failures `smoke-tested`
- trusted workspace flow `live-proven`
- visible tool activity `live-proven`

Next:

- OpenRouter exactness/fidelity hardening after the hosted-provider batch
- more realistic multi-tool live tasks

### 2. Executable skills

State: strong.

Done:

- provider-backed skill execution `smoke-tested`
- deterministic fallback path `smoke-tested`
- session-stable skill visibility `live-proven`
- external dirs `smoke-tested`
- skill package indexing `smoke-tested`
- skill mutation actions `smoke-tested`
- load-time setup context `smoke-tested`

Next:

- more operational env/credential-backed script conventions
- Skills Hub/distribution later

### 3. Memory and sessions

State: partial.

Done:

- bounded memory files `smoke-tested`
- session DB `live-proven` on gateway path
- persisted channel session context `smoke-tested`
- Telegram session identity policy for DM/group/thread behavior `smoke-tested`
- Telegram auto-reset session lifecycle on gateway path `smoke-tested`
- history packing `smoke-tested`
- prompt cache `smoke-tested`
- skill outcome persistence `smoke-tested`

Next:

- repeated workflow promotion
- better session-summary preservation
- compression protection around recent tool pairs
- richer session-admin UX: lineage / history / resume controls beyond the current `/sessions`, `/search`, and `/switch`

### 4. Channels

State: meaningful Telegram alpha.

Done:

- Telegram adapter `live-proven`
- allowlist/pairing `smoke-tested`
- approvals `smoke-tested`
- inline approval UX `smoke-tested`
- compact progress `smoke-tested`
- attachment download + document path `live-proven` for documents
- vision-backed image analysis support in runtime `live-proven` with Kimi
- gateway diagnostics `live-proven`

Next:

- broader live image verification beyond Kimi
- more Telegram final UX polish
- channel verbosity/profile controls
- next launch channel after Telegram is stable

### 5. Onboarding and packaging

State: partial.

Done:

- setup CLI `smoke-tested`
- onboarding path `smoke-tested`
- provider config `smoke-tested`
- doctor checks `live-proven`

Next:

- external-user-quality install flow
- local model setup polish
- packaging/distribution decision

### 6. Internal alpha operations

State: good.

Done:

- alpha harness `live-proven`
- runbook `live-proven`
- repeatable run folders `live-proven`

Next:

- stronger pass/fail release gate behavior
- more guided live checks

### 7. Evaluation substrate

State: first foundation now exists.

Done:

- task-based eval scaffold `implemented`
- eval task catalog under `evals/tasks` `implemented`
- repeatable eval-run folders under `.estacoda/eval-runs` `implemented`

Next:

- structured scoring beyond pass/fail
- baseline vs candidate comparison
- skill-first batch evaluation
- eventual substrate for safe self-evolution loops

### 8. MCP and ACP

State: MCP client foundation now includes stdio + HTTP; the stdio path is now live-proven against a real filesystem MCP server. ACP foundation now exists as a stdio JSON-RPC server, and the JetBrains editor flow is now live-proven for chat, editor-backed file reads, shell execution, and approval prompts, but full editor parity is still not implemented.

Done:

- stdio MCP client transport `live-proven`
- HTTP MCP client transport `smoke-tested`
- config-driven MCP server registration/discovery `live-proven` on stdio, `smoke-tested` on HTTP
- MCP tool/resource/prompt discovery and registration into the normal runtime loop `live-proven` on stdio, `smoke-tested` on HTTP
- reload semantics via `estacoda mcp reload` and `/reload-mcp` `live-proven`
- per-server trust metadata now maps MCP tools into runtime risk classes; trusted stdio filesystem execution is `live-proven`
- auxiliary provider routing still reserves an `mcp` task label `implemented`
- ACP foundation now exists with:
  - `estacoda acp serve`
  - `estacoda acp manifest`
  - `acp_registry/agent.json`
  - core methods: `initialize`, `authenticate`, `session/new`, `session/load`, `session/list`, `session/prompt`, `session/cancel`
  - streaming `session/update` notifications for session info, thought chunks, tool calls, agent message chunks, and usage
  - editor-backed file reads in JetBrains
  - approval prompts and explicit shell execution in JetBrains
  `basic editor flow live-proven`

Next:

- add richer per-server trust/visibility controls
- refine resource/prompt ergonomics
- deepen ACP toward Hermes parity after MCP client and memory/session maturity
  The next explicit live proof should be richer terminal/process rendering and cleaner result formatting across editor clients.
- treat MCP server bridging as later than MCP client and ACP

## Correct Next Milestone

The best next milestone is:

1. **workflow-learning refinement**
2. **MCP trust/visibility refinement**
3. **evaluation substrate expansion**
4. **onboarding/distribution polish**
5. **ACP/editor embedding only after MCP client and memory/session maturity**

## Product Gap Analysis

The following product areas came up explicitly and should be treated as tracked gaps rather than fuzzy future ideas.

### 1. Onboarding experience

State: partially built.

- interactive onboarding exists `smoke-tested`
- provider setup/config exists `smoke-tested`
- doctor/health checks exist `live-proven`
- external-user-quality onboarding is still `intended but not implemented`

What remains:

- cleaner first-run path for non-builders
- better recovery from bad credentials/config
- clearer provider selection UX, especially around vision and local models

### 2. Migration from Hermes / OpenClaw

State: not meaningfully built.

- no migration CLI
- no import path for skills/config/memory
- no compatibility guide
- currently `intended but not implemented`

What remains:

- migration guide doc
- import mapping for skills/config where feasible
- explicit statement of what can and cannot be carried over

### 3. Telegram pairing flow

State: partially built.

- allowlist and pairing concepts exist `smoke-tested`
- gateway security flow exists `smoke-tested`
- security approval modes now exist across CLI/runtime/channel/ACP: `strict`, `adaptive`, `open` `smoke-tested`
- adaptive assessor path now exists with structured fallback-to-ask behavior `smoke-tested`
- fully polished pairing UX is `implemented but not live-proven`

What remains:

- cleaner first-contact pairing flow
- clearer pairing diagnostics
- operator proof of the full pairing path

### 4. Local and open-source models

State: architecturally supported, operationally partial.

- provider routing supports non-hosted routes `smoke-tested`
- local-model UX/polish is still `intended but not implemented`

What remains:

- operator-friendly local model setup
- explicit support matrix for text vs tool calling vs vision
- onboarding help for Ollama/local routes

### 5. UI design

State: only surface-level so far.

- Telegram and CLI interaction polish exists `live-proven` / `smoke-tested`
- broader UI/system design is `intended but not implemented`

What remains:

- product-level design language
- cross-channel response style system
- future visual surfaces beyond CLI/Telegram

### 6. RL capabilities

State: groundwork only.

- trajectory recording exists `smoke-tested`
- real RL/eval/improvement loop is `intended but not implemented`

What remains:

- data pipeline and eval policy
- reward/selection logic
- agent-improvement loop that is actually operational

### 7. Voice to text

State: not built.

- TUI voice input is `intended but not implemented`
- Telegram/channel voice handling is `intended but not implemented`

What remains:

- transcription path
- per-channel UX
- security/privacy stance for audio processing

### 8. Profiles and modes

State: partial concept only.

- some adjacent behavior exists, like bilingual activity labels and approval/trust modes
- real user-facing profiles/modes are `intended but not implemented`

What remains:

- verbosity profiles
- channel-specific mode settings
- user/profile persistence model

### 9. Update story

State: not built.

- no real self-update or release-channel UX
- packaging path is still undecided
- overall update story is `intended but not implemented`

What remains:

- release/install method decision
- version/update command or package-manager path
- migration behavior across releases

### 10. MCP / ACP

State: MCP client foundation now exists across stdio + HTTP; ACP foundation now exists, and basic editor chat plus editor-backed file reads are now live-proven, but only the first editor slice is implemented.

- stdio MCP client transport exists `live-proven`
- HTTP MCP client transport exists `smoke-tested`
- MCP config surface exists `live-proven` on stdio usage, `smoke-tested` more broadly
- MCP tool/resource/prompt discovery exists `live-proven` on stdio usage, `smoke-tested` more broadly
- reload semantics now exist:
  - `estacoda mcp reload`
  - `/reload-mcp`
  `smoke-tested`
- per-server trust metadata exists and currently maps server trust to runtime risk classes `smoke-tested`
- ACP adapter/server foundation now exists; base editor flow is `live-proven`
- current `mcp` auxiliary route remains a routing preference construct, not the protocol client itself

What remains:

- Phase 1: MCP client for stdio servers `done / smoke-tested`
- Phase 2: trust/visibility refinement and richer resource/prompt ergonomics
- Phase 3: ACP foundation `done`; base editor flow is `live-proven`, and next is live approval proof plus richer editor/tool parity
- Later: MCP server bridge if/when EstaCoda should expose messaging/approvals outward the way Hermes does

## Launch Readiness Read

Closest honest label:

- usable internal alpha: yes
- small private MVP soon: yes
- public-ready MVP today: no

Main blockers to MVP:

- repeated user preferences and project facts now promote cleanly, and bounded workflow learning now exists through `skills.autonomy`
- the next gap is better workflow heuristics, candidate quality, and skill patch/update behavior rather than basic workflow learning itself
- provider-route hardening is incomplete
- Telegram image path is live-proven with Kimi, but not yet broadly proven across providers
- install/distribution polish is not done
- channel-level verbosity/profile controls are still missing
