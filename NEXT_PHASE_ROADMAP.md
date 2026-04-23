# EstaCoda v2 Next Phase Roadmap

This phase turns the first working provider-backed agent loop into a reliable Hermes-class product core.

## Current Baseline

- Live provider inference works with Kimi.
- Live provider tool-calling works for `file.read`.
- Live multi-step provider workflows work for `file.write` -> `file.read` -> final verification.
- Local smoke coverage verifies `file.read` -> `file.replace` -> `file.read` edit workflows.
- Malformed provider tool calls produce corrective feedback and can recover on the next provider turn.
- Unavailable or legacy provider tool names produce corrective feedback and can recover with an exposed provider schema.
- Provider-safe tool aliases work, for example `file_read` maps to `file.read`.
- Trusted workspace execution works without repeated permission prompts.
- Tool results are packetized into continuation prompts.
- CLI tool activity is visible in one-shot and interactive sessions.
- `doctor --live-tools` can verify provider tool-calling against the configured model.

## Phase Goals

1. Make normal multi-step agent tasks reliable.
2. Make skills executable as reusable workflow packages.
3. Mature memory/session persistence into learning behavior.
4. Harden Telegram/channel runtime for real usage.
5. Finish first-run onboarding and packaging enough for outside users.

## Workstreams

### 1. Multi-Step Agent Tasks

Status: core write/read, edit/replace, malformed tool-call recovery, and unavailable-tool recovery loops work in smoke coverage.

Next acceptance checks:
- Done: provider can write a file with `file.write`.
- Done: provider can read it back with `file.read`.
- Done: provider can verify final state from tool results.
- Done: provider can edit a file with `file.replace`.
- Done: provider can read the edited file back with `file.read`.
- Done: provider can verify the edit from tool results.
- Done: malformed tool calls produce recoverable feedback.
- Done: unavailable tool calls produce recoverable feedback.
- Terminal activity shows each tool step clearly.

### 2. Executable Skills

Status: loading, routing, slash menu, import/export/create, workflow planning, outcome memory, provider-backed skill handoff, and Hermes-style session-stable skill visibility exist.

Next acceptance checks:
- Done: a selected skill loads `SKILL.md` into the provider prompt with workflow context.
- Provider-backed sessions execute selected skills through the normal tool loop instead of deterministic pre-runs.
- Deterministic skill execution remains available as the no-provider fallback path.
- Installed/imported skills become provider-visible on session refresh or a new session, not by silent mid-session mutation.
- CLI exposes `/reset` as the explicit session refresh boundary for new skill/config snapshots.
- Skill steps can request files/context/tools without bespoke code.
- Skill outcomes are recorded to memory.
- Skill creation/import immediately updates slash menus and tool-visible catalog.

### 3. Memory And Sessions

Status: `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`, memory provider, session DB, SQLite session store, history packing, and prompt cache exist.

Next acceptance checks:
- Repeated user preferences are promoted into `USER.md`.
- Repeated workflows are promoted into `MEMORY.md` or skills.
- Session summaries preserve active task state.
- Long sessions preserve recent tool-call/result pairs during compression.

### 4. Channels

Status: generic channel contracts, Telegram adapter, pairing, allowlists, media download, and gateway smoke tests exist.

Next acceptance checks:
- Telegram runs against the v2 provider/tool loop in a real session.
- Telegram media triggers attachment-aware skills.
- Gateway status and startup UX are clear.
- Channel approval/denial flows work for gated actions.

### 5. Installer And Onboarding

Status: setup CLI, interactive onboarding, provider config, onboarding tools, first-run path, and doctor checks exist.

Next acceptance checks:
- A fresh user can install, configure a model, trust a workspace, and complete a first prompt.
- Local model setup is supported cleanly.
- Config errors produce actionable fixes.
- Packaging path is defined for binary/npm/homebrew-style distribution.

## Immediate Next Step

Harden executable skill workflows end to end:

1. Load a selected `SKILL.md` into the active prompt as operating instructions.
2. Compile the skill workflow into concrete plan context for the provider.
3. Let the provider execute the workflow through normal tool calls and continuations.
4. Keep deterministic workflow execution as the fallback path when no provider is configured.
5. Preserve Hermes-style session-stable skill visibility; require refresh/new session for provider-visible skill updates.
6. Record skill outcomes to memory and trajectory logs.
7. Ensure refreshed sessions pick up newly installed/imported skills in slash menus and provider-visible skill indexes.

Keep live Kimi/OpenRouter/Ollama tests batched at the end of the workstream so provider-specific quirks are debugged together.
