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
- Hermes-aligned skill visibility now uses session-stable snapshots plus explicit refresh via `/reset`.
- Hermes-aligned external skill directories now support `~` and `${VAR}` expansion, read-only discovery, silent skip for missing paths, and local precedence over external skills.
- Hermes-style skill mutation actions exist: create, patch, edit, delete, write supporting file, remove supporting file.
- Skill packages now index `references/`, `templates/`, `scripts/`, and standards-compatible `assets/`.
- Skill load-time setup now resolves required environment variables, credential-file presence, and `metadata.hermes.config` fields without exposing secrets.
- Provider-backed skill smokes now cover templates, scripts, progressive disclosure, package refresh, and a composed reference + template + script workflow.
- Telegram now runs through the real v2 provider/tool loop with attachment manifests, attachment-aware inspection, approval persistence, inline approval buttons, compact progress updates, and shared bilingual activity labels.
- Gateway startup/status diagnostics now expose adapter readiness, security mode, token/env presence, model route, state paths, and command-sync status.
- Security approval modes now use EstaCoda naming: `strict`, `adaptive`, `open`, while preserving backward compatibility for old config values.
- Adaptive security can now call an auxiliary assessor for ambiguous actions, while malformed/timeout cases fall back to approval-required and hard floors still deny.
- CLI approvals now support `once`, `session`, and `always`, with persistent workspace approval revocation and the same target-key matching model used by channel approvals.
- The hard floor now covers broader destructive commands, explicit secret reads, pipe-to-interpreter installs, and force-push patterns, and adaptive assessment now has a dedicated `approval` auxiliary route.
- An internal alpha harness and runbook now exist for repeatable operator testing across CLI, Telegram, providers, approvals, and reset/rollback flow.

## Phase Goals

1. Make normal multi-step agent tasks reliable.
2. Make skills executable as reusable workflow packages.
3. Mature memory/session persistence into learning behavior.
4. Harden Telegram/channel runtime for real usage.
5. Finish first-run onboarding and packaging enough for outside users.

## Workstreams

### 1. Multi-Step Agent Tasks

Status: core write/read, edit/replace, malformed tool-call recovery, unavailable-tool recovery, provider-safe tool aliases, and visible tool activity all work in smoke coverage.

Next acceptance checks:
- Done: provider can write a file with `file.write`.
- Done: provider can read it back with `file.read`.
- Done: provider can verify final state from tool results.
- Done: provider can edit a file with `file.replace`.
- Done: provider can read the edited file back with `file.read`.
- Done: provider can verify the edit from tool results.
- Done: malformed tool calls produce recoverable feedback.
- Done: unavailable tool calls produce recoverable feedback.
- Done: terminal activity shows each tool step clearly.

Remaining hardening:
- Live provider batch now proves Kimi/OpenAI/DeepSeek as full passes. OpenRouter runtime path works but still needs exactness/fidelity hardening; local/Ollama is not validated in the current environment.
- Expand normal-task live testing beyond smoke fixtures into more realistic multi-tool tasks.

### 2. Executable Skills

Status: Hermes-aligned skill loading, routing, slash menu, import/export/create/edit/patch/delete, workflow planning, outcome memory, provider-backed execution, session-stable visibility, external skill dirs, runtime visibility filtering, skill package indexing, and load-time setup context all exist.

Next acceptance checks:
- Done: a selected skill loads `SKILL.md` into the provider prompt with workflow context.
- Done: provider-backed sessions execute selected skills through the normal tool loop instead of deterministic pre-runs.
- Done: deterministic skill execution remains available as the no-provider fallback path.
- Done: installed/imported skills become provider-visible on session refresh or a new session, not by silent mid-session mutation.
- Done: CLI exposes `/reset` as the explicit session refresh boundary for new skill/config snapshots.
- Done: skill steps can request files/context/tools without bespoke code.
- Done: skill outcomes are recorded to memory.
- Done: skill creation/import updates slash menus and tool-visible catalog under Hermes-style session semantics.
- Done: provider-backed template workflows execute through `skill.view` -> file tool continuations.
- Done: provider-backed script workflows execute through `skill.view` -> `terminal.run` / `execute_code` continuations.
- Done: progressive disclosure is enforced in smoke coverage.
- Done: skill package contents stay session-stable until refresh/new session.

Remaining hardening:
- Make env/credential-backed script execution conventions more operational in live provider runs.
- Add Skills Hub / distribution layer later without changing the runtime skill model.

### 3. Memory And Sessions

Status: `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`, memory provider, session DB, SQLite session store, history packing, prompt cache, skill outcome persistence, repeated user-preference promotion, repeated project-fact promotion, and bounded workflow-to-skill learning exist.

Next acceptance checks:
- Done: repeated user preferences are promoted into `USER.md` with contradiction handling, strengthening, forgetting, and inspection.
- Done: repeated project facts/conventions are promoted into `MEMORY.md`.
- Done: repeated bounded local workflows can become candidates or project skills depending on `skills.autonomy`.
- Session summaries preserve active task state.
- Long sessions preserve recent tool-call/result pairs during compression.

Follow-on protocol work after this milestone:
- MCP client stdio + HTTP foundation is now in place with config-driven discovery, trust metadata, tool/resource/prompt registration, and reload semantics; the stdio path is now live-proven against a real filesystem MCP server.
- ACP foundation is now in place as a stdio JSON-RPC server with session lifecycle methods and streaming updates, and the JetBrains editor flow is now live-proven for chat, editor-backed file reads, shell execution, and approval prompts; deeper editor parity should still wait until after stronger memory/session maturity.
- MCP server bridging should still come later than MCP client and likely later than ACP.

### 4. Channels

Status: generic channel contracts, Telegram adapter, pairing, allowlists, media download, real provider-backed Telegram text flow, attachment execution E2E, approval persistence/revocation, inline Telegram approval UX, gateway diagnostics, compact bilingual progress updates, persisted channel session context, and policy-driven Telegram session lifecycle all exist.

Next acceptance checks:
- Done: Telegram runs against the v2 provider/tool loop in a real session.
- Done: Telegram media triggers attachment-aware skills through attachment manifests and normal inspection tools.
- Done: gateway status and startup UX are clear enough for operator testing.
- Done: channel approval/denial flows work for gated actions, including persistent approvals and revocation.
- Done: gateway sessions survive restart with persisted active-session mapping, explicit DM/group/thread policy, and configurable auto-reset lifecycle.

Remaining hardening:
- Polish Telegram final reply formatting so answers feel chat-native rather than terminal-native.
- Run and tighten live Telegram attachment/operator passes in the alpha harness, including unsupported-type and failure-path UX.
- Add channel-level verbosity/profile controls so progress/detail level can vary by surface without exposing raw tool names by default.
- Expand beyond Telegram to the next launch channels after Telegram feels production-stable.

### 5. Installer And Onboarding

Status: setup CLI, interactive onboarding, provider config, onboarding tools, first-run path, and doctor checks exist.

Next acceptance checks:
- A fresh user can install, configure a model, trust a workspace, and complete a first prompt.
- Local model setup is supported cleanly.
- Config errors produce actionable fixes.
- Packaging path is defined for binary/npm/homebrew-style distribution.

### 6. Internal Alpha Operations

Status: a repeatable internal alpha runbook and harness exist, with generated notes/commands/log folders and reset instructions for real operator passes.

Next acceptance checks:
- Done: one operator can run preflight, CLI, provider, and Telegram checks from a repeatable harness.
- Failures are recorded in a single run folder with logs, notes, and artifacts.
- Reset/rollback instructions are easy enough to follow between runs.

Remaining hardening:
- Turn the harness from “repeatable manual run” into a stronger release gate with clearer pass/fail checkpoints.
- Add more guided live checks for Telegram attachments, approval cards, and provider-route comparison.

## Immediate Next Step

Move from strong internal alpha behavior to MVP launch hardening:

1. Refine workflow-learning heuristics and skill patching behavior now that project-fact promotion and `skills.autonomy` exist.
2. Refine MCP trust/visibility controls and real-server validation.
3. Finish first-run install/onboarding polish and define the external distribution path.
4. Expand the evaluation substrate into stronger scored comparisons.
5. Revisit ACP/editor embedding only after the MCP client and memory/session work are in better shape.

Keep Hermes alignment as the default rule:
- session-stable snapshots over silent mutation
- progressive disclosure over eager expansion
- skill execution through the normal agent loop and tool system
- secrets never injected into provider prompts
