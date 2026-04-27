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

- broader live provider hardening
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
- history packing `smoke-tested`
- prompt cache `smoke-tested`
- skill outcome persistence `smoke-tested`

Next:

- repeated preference promotion
- repeated workflow promotion
- better session-summary preservation
- compression protection around recent tool pairs

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

## Correct Next Milestone

The best next milestone is:

1. **live Telegram image verification with a real vision-capable route**
2. **live provider hardening batch**
3. **memory promotion implementation**
4. **onboarding/distribution polish**

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

## Launch Readiness Read

Closest honest label:

- usable internal alpha: yes
- small private MVP soon: yes
- public-ready MVP today: no

Main blockers to MVP:

- memory promotion is still missing
- provider-route hardening is incomplete
- Telegram image path is live-proven with Kimi, but not yet broadly proven across providers
- install/distribution polish is not done
- channel-level verbosity/profile controls are still missing
