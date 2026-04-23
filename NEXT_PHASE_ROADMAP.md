# EstaCoda v2 Next Phase Roadmap

This phase turns the first working provider-backed agent loop into a reliable Hermes-class product core.

## Current Baseline

- Live provider inference works with Kimi.
- Live provider tool-calling works for `file.read`.
- Live multi-step provider workflows work for `file.write` -> `file.read` -> final verification.
- Local smoke coverage verifies `file.read` -> `file.replace` -> `file.read` edit workflows.
- Malformed provider tool calls produce corrective feedback and can recover on the next provider turn.
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

Status: core write/read, edit/replace, and malformed tool-call recovery loops work in smoke coverage.

Next acceptance checks:
- Done: provider can write a file with `file.write`.
- Done: provider can read it back with `file.read`.
- Done: provider can verify final state from tool results.
- Done: provider can edit a file with `file.replace`.
- Done: provider can read the edited file back with `file.read`.
- Done: provider can verify the edit from tool results.
- Done: malformed tool calls produce recoverable feedback.
- Unavailable tool calls produce recoverable feedback.
- Terminal activity shows each tool step clearly.

### 2. Executable Skills

Status: loading, routing, slash menu, import/export/create, workflow planning, and outcome memory exist.

Next acceptance checks:
- A skill can load `SKILL.md` and execute a multi-tool workflow.
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

Harden unavailable-tool recovery through the normal provider loop:

1. Provider requests an unavailable or legacy tool name.
2. EstaCoda records the failed tool plan with the mapped status and error.
3. EstaCoda sends the failure back through provider continuation with available schemas.
4. Provider corrects the call to an available tool.
5. EstaCoda executes the corrected tool and returns results.
6. Provider produces a final answer based on the corrected result.

This should mirror the malformed-call recovery path and keep live Kimi/OpenRouter tests batched at the end of the workstream.
