# EstaCoda Agent Development Guide

Development guide for human contributors and AI coding agents working on EstaCoda.

This file is operational instruction. It is not product marketing, roadmap prose, or contributor onboarding. Use it when changing code, reviewing agent-produced patches, or handing work from one agent to another.

## What EstaCoda Is

EstaCoda is a governed agentic harness for trusted autonomous execution. It runs agents through a CLI, setup/editor flows, local tools, browser automation, messaging channels, memory, skills, scheduled/background work, and reviewable Agent Evolution.

Two properties shape almost every change:

- Trust boundaries are product behavior. Workspace trust, approval modes, hardline command blocks, profile scoping, channel authorization, credential storage, browser/private URL policy, cloud-spend approval, and install/update ownership are not implementation details.
- Autonomy must stay inspectable. Skills, memory, workflow state, traces, proposals, and generated changes may help the agent improve, but promotion must remain reviewable, reversible, and bounded by explicit policy.

## Core rule

Make the smallest correct change that preserves the safety model.

EstaCoda is agent infrastructure. A small bug can become remote code execution, secret exposure, unsafe command approval, poisoned memory, cross-profile leakage, unauthorized gateway control, or broken workspace trust. Treat runtime behavior, skills, tools, memory, gateway access, setup, lifecycle, and security policy as sensitive surfaces.

## Operating principles

1. Read before editing.
2. Prefer narrow patches over broad rewrites.
3. Keep human control explicit at trust boundaries.
4. Never weaken security checks to make a test pass.
5. Never log secrets, tokens, API keys, private paths, or user content unnecessarily.
6. Keep generated and learned behavior reviewable.
7. Keep CLI output deterministic enough to test.
8. Preserve Arabic and bidirectional text handling when touching localized UX.
9. Do not silently change public behavior without docs and tests.
10. Leave the repo cleaner than you found it.

## Contribution rubric — what we want / what we do not want

### What we want

- Small, verified fixes that preserve the safety model.
- Changes that improve autonomous execution without making behavior opaque.
- Setup and configuration changes that route through reviewed apply paths instead of hidden mutation.
- Security-sensitive changes with explicit tests and a short risk note.
- Provider, channel, browser, tool, and capability additions that use existing registries, setup flows, and capability gates.
- Skill and Agent Evolution changes that keep proposals reviewable and reversible.
- Terminal UI changes that preserve Arabic, bidirectional text, plain rendering, and deterministic testability.
- Documentation that matches implemented behavior with no aspirational claims.

### What we do not want

- Speculative subsystems, hooks, registries, managers, or extension points without a live consumer.
- New secret-looking environment variables for non-secret settings.
- Capabilities that bypass setup, trust, approval, profile, channel authorization, browser safety, or install/update ownership boundaries.
- New core tools when an existing tool, skill, CLI command, MCP integration, setup action, or optional capability is the right surface.
- Security fixes that disable the feature instead of preserving its intended safe behavior.
- Agent Evolution paths that silently mutate live skills, prompts, memory, or runtime policy.
- Snapshot or fixture churn that freezes incidental output.
- Public docs that describe planned behavior as live.

## Before you call it a bug

Verify the premise against current code before changing behavior.

Common false premises:

- Workspace trust should load project config. It should not. Workspace trust gates behavior; it does not merge project config into the active profile.
- Open mode means security off. It does not. The hardline floor still applies.
- Skipped setup capability means broken setup. Optional capabilities are optional; skipped features must not block core setup.
- A skill proposal should patch the live skill immediately. It should not. Agent Evolution records evidence and proposals; promotion is gated.
- A provider route always needs an API key. Some routes use OAuth in profile-local `auth.json`, and some providers support `authMethod: "none"`.
- Renderer snapshots are always bad. They are valid for terminal UI surfaces; avoid snapshots for behavioral contracts.

When in doubt, read the code path and ask for maintainer direction before widening behavior.

## Required workflow for agents

Before editing:

1. Inspect the relevant files.
2. Identify the smallest set of files needed.
3. Check whether the change touches a security-sensitive area.
4. Check whether the change requires docs or tests.
5. Avoid unrelated cleanup.

While editing:

1. Keep commits focused.
2. Do not refactor adjacent code unless it directly reduces risk or the task is explicitly a refactor.
3. Do not update snapshots, expected outputs, catalogs, or generated files blindly.
4. Do not introduce new dependencies without a clear reason.
5. Do not edit lockfiles unless dependency changes require it.
6. Do not modify generated files unless the generator was run intentionally.

After editing:

1. Run formatting or linting only where configured.
2. Run the minimum relevant test first.
3. Run the standard validation commands before declaring full success.
4. Summarize changed files, checks run, and remaining risks.

## Standard validation commands

Use the commands that exist in the repo. The current default validation set is:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
git diff --check
```

When tests exist for the touched area, run them too:

```bash
pnpm exec vitest run <path>
```

If the repo adds a stronger wrapper later, use the wrapper instead of raw test commands. The wrapper should become the CI-parity entry point.

Do not claim validation passed unless the command was actually run.

## Project structure

The filesystem is the source of truth. This map is a guide, not a guarantee.

```text
estacoda/
├── src/
│   ├── acp/                   # ACP editor integration
│   ├── artifacts/             # Artifact store and formatting
│   ├── browser/               # Browser backend, URL safety, cloud browser gating
│   ├── capabilities/          # Capability setup helpers and secret references
│   ├── channels/              # Channel adapters and channel contracts
│   ├── cli/                   # CLI, interactive session loop, slash commands
│   ├── config/                # Runtime config loading, defaults, profile paths
│   ├── context/               # Context references and project context
│   ├── contracts/             # Pure TypeScript types shared across layers
│   ├── cron/                  # Scheduled task store and tools
│   ├── delegation/            # Subagent delegation manager
│   ├── diagnostics/           # Diagnostics and status helpers
│   ├── eval/                  # Evaluation support
│   ├── evolution/             # Agent Evolution stores, manifests, proposals
│   ├── gateway/               # Gateway supervision, approval queue, delivery hooks
│   ├── knowledge/             # Knowledge/context support
│   ├── lifecycle/             # Install/update/uninstall/version lifecycle
│   ├── mcp/                   # MCP client/server integration
│   ├── memory/                # Memory stores, promotion, recall, rendering
│   ├── model-catalog/         # Offline model registry and profiles
│   ├── packs/                 # Skills/capability pack support
│   ├── process/               # Process manager and tools
│   ├── prompt/                # Prompt assembly, caching, compression, packing
│   ├── providers/             # Provider registry, executor, adapters, auth
│   ├── python-env/            # Managed Python capability environment
│   ├── reports/               # Reports and diagnostics output
│   ├── runtime/               # Agent loop, router, tool planning/execution
│   ├── search/                # Search and retrieval support
│   ├── security/              # Command policy, approvals, trust checks
│   ├── session/               # Session DB and persistence
│   ├── setup/                 # First-run setup, setup editor, review/apply
│   ├── skills/                # Skill loading, routing, playbooks, learning
│   ├── smoke/                 # Smoke test support
│   ├── storage/               # Storage utilities
│   ├── tasks/                 # Durable Task state and orchestration
│   ├── test/                  # Test helpers
│   ├── theme/                 # UI theme definitions
│   ├── tools/                 # Tool schemas, registry, executor, planners
│   ├── trajectory/            # Trajectory recorder and persistence
│   ├── types/                 # Additional TypeScript declarations
│   ├── ui/                    # ViewModels, renderers, UI labels/settings
│   ├── utils/                 # Shared runtime utilities
│   └── workers/               # Worker process integration
├── skills/                    # Built-in official skills
├── registries/                # Source registries and generated/catalog inputs
├── website/                   # Docusaurus docs/marketing site
├── docs/                      # Architecture, operations, subsystem docs
├── scripts/                   # Project scripts, installers, bridges
├── workers/                   # Worker assets shipped with package
├── assets/                    # Static/runtime assets
├── acp_registry/              # ACP registry metadata
├── evals/                     # Evaluation fixtures/tasks
├── .github/                   # CI, issue templates, PR templates
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
└── AGENTS.md
```

If the actual tree differs, follow the actual tree and update this file only when the difference is durable.

## Architecture overview

EstaCoda is a TypeScript-first agent runtime with Node.js as the production runtime, pnpm/Corepack as the source package-manager default, compiled `dist/` as the release target, and Bun as an optional dev-speed lane only.

The main architectural surfaces are:

1. CLI, setup, and setup editor.
2. Provider/model routing and credential resolution.
3. Security policy, approvals, workspace trust, and command hardline floor.
4. Runtime loop, tool planning, and tool execution.
5. Skills, skill routing, and playbooks.
6. Agent Evolution, proposals, eval gates, manifests, snapshots, and rollback metadata.
7. Memory, session recall, prompt packing, and compression.
8. Gateway, channels, delivery, and remote approval queues.
9. Browser, web/search, Python environment, and managed optional capabilities.
10. Install/update/uninstall lifecycle and release packaging.
11. Documentation, website, and public repo governance.

Agents must avoid treating these as isolated modules. Changes in one layer often affect safety in another layer.

Example: a routing change can cause the wrong skill to load, which can expose the wrong tool, which can trigger the wrong approval path.

## Capability surface ladder

Choose the least permanent surface that correctly solves the problem:

1. Extend existing code.
2. Add or update docs, skill, or playbook guidance.
3. Add a CLI command or setup-editor action.
4. Add a gated optional capability.
5. Add an MCP/server integration or external bridge.
6. Add a model-visible tool.
7. Add a core runtime subsystem.

Rules:

1. The farther down the ladder, the more review, tests, docs, and security analysis are required.
2. Model-visible tools are expensive because they affect prompts and tool schemas.
3. Remote-control, command execution, credential, browser, package-install, and gateway surfaces need explicit security review.
4. Do not add new core surface for niche workflows if a skill, CLI command, setup action, or optional capability is enough.

## Security-sensitive areas

Treat these as high scrutiny:

```text
src/security/
src/tools/
src/runtime/
src/gateway/
src/channels/
src/browser/
src/providers/
src/config/
src/setup/
src/lifecycle/
src/python-env/
src/skills/
src/evolution/
src/memory/
src/packs/
src/search/
src/prompt/
src/session/
src/tasks/
skills/
registries/
scripts/install.sh
scripts/setup-estacoda.sh
scripts/uninstall.sh
scripts/whatsapp-bridge/
.github/workflows/
package/release scripts and generated release artifacts
```

A change is security-sensitive if it affects any of the following:

1. Command execution.
2. File read or write permissions.
3. Workspace trust.
4. Gateway authorization, routing, delivery, or session attachment.
5. Telegram, WhatsApp, Discord, Email adapter paths where enabled/configured, or other remote-control surfaces.
6. API key, OAuth token, credential, or environment variable handling.
7. Skill loading, skill routing, skill patch promotion, or pack exposure.
8. Memory writing, memory retrieval, session recall, or prompt packing.
9. Provider prompts, model routing, auxiliary models, or tool schemas.
10. Approval bypasses, persistent approvals, or gateway approval queues.
11. Browser/private URL policy, cloud metadata blocking, or cloud-spend approval.
12. Network access, search, web extraction, or redirects.
13. Install, update, uninstall, package ownership, or release automation.
14. Managed Python package/model downloads or local capability caches.
15. Profile isolation and cross-profile state.
16. Agent Evolution proposal, eval, promotion, rollback, or manifest gates.
17. CI secrets, publishing, or deployment automation.

Security-sensitive PRs need explicit reviewer attention and should include a short risk note.

## Secrets and configuration

Secrets belong in environment variables or local secret files that are ignored by git.

Do not commit:

```text
.env
*.pem
*.key
API keys
bot tokens
provider tokens
OAuth tokens
personal access tokens
private SSH keys
real user config
real logs containing secrets
browser profiles or auth state
channel auth state
```

Non-secret settings belong in config files, not `.env`.

Examples of non-secret settings:

```text
timeouts
feature flags
language preference
display preference
model name
provider name
terminal working directory
approval mode
Agent Evolution mode
```

Examples of secrets:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
KIMI_API_KEY
TELEGRAM_BOT_TOKEN
GITHUB_TOKEN
QUIQUP_API_KEY
```

Do not print full secrets. If a value must be displayed for debugging, show only a fixed redacted form:

```text
abcd...wxyz
```

## Runtime state and profiles

Runtime state should live under an EstaCoda home directory, not hardcoded project paths.

Expected pattern:

```text
~/.estacoda/
├── active-profile.json              # global selected profile pointer
├── trust.json                       # global workspace trust
├── workspace-approvals.json         # global approval grants
├── sessions.sqlite                  # global sessions and gateway approval rows
├── bin/                             # managed executable/wrapper links
├── packs/                           # global pack state/cache
├── memory/
│   └── shared/                      # global shared memory only
└── profiles/
    └── <profile-id>/
        ├── config.json              # selected profile runtime config
        ├── .env                     # profile-local API-key env values
        ├── auth.json                # profile-local OAuth/token store
        ├── USER.md
        ├── SOUL.md
        ├── MEMORY.md
        ├── promotions.json
        ├── skills/
        ├── cron/
        ├── logs/
        ├── gateway/
        ├── channel-media/
        ├── audio-cache/
        ├── image-cache/
        └── temp/
```

Managed runtime/cache paths, including Python environment state and downloaded models/packages, are security-sensitive even when they are outside profile config. Do not move them into the repo or let generated instructions choose arbitrary install paths.

Profile-safe code rules:

1. Use `resolveGlobalStateHome()` and `resolveProfileStateHome()` instead of hardcoded paths.
2. Treat `active-profile.json`, trust, workspace approvals, `sessions.sqlite`, shared memory, `bin/`, and `packs/` as global.
3. Treat `config.json`, `.env`, `auth.json`, `USER.md`, `SOUL.md`, `MEMORY.md`, promotions, skills, cron, logs, gateway, media, caches, and temp as profile-local.
4. Never read or write another profile unless the user explicitly selected it.
5. Do not leak credentials, memory, approvals, gateway state, channel state, or logs across profiles.
6. Runtime config loads exactly one selected profile config; do not reintroduce user/project config merging.
7. Provider credentials resolve through the runtime credential resolver. API-key routes use configured env var references and profile `.env` values. OAuth routes use profile-local `auth.json`. Providers or routes with `authMethod: "none"` require no credential. Do not reintroduce credential pools or cross-profile credential sharing.
8. Workspace trust is global directory action trust only. It gates behavior, not config loading.
9. `USER.md`, `SOUL.md`, `MEMORY.md`, and `promotions.json` are profile-local. Global shared memory is only `~/.estacoda/memory/shared/`.
10. `--profile <id>` or `-p <id>` style overrides must be command-local unless the command is explicitly `profile use`.

## CLI, setup, and setup editor rules

CLI setup is a product surface and a trust surface.

When changing CLI or setup code:

1. Preserve keyboard navigation.
2. Preserve terminal redraw behavior.
3. Avoid rendering bugs caused by cursor restore after scroll.
4. Keep selector UI centralized.
5. Do not duplicate interactive selector logic across files.
6. Keep language selection early in the Onboarding Wizard.
7. Keep workspace trust explicit.
8. Keep provider setup separate from optional capability setup.
9. Do not imply that skipped optional features are required.
10. Do not claim full runtime localization unless it exists.
11. Keep Onboarding Wizard profile handling silent: setup may create/select the default profile behind the scenes, but normal Onboarding Wizard copy should not require profile awareness.
12. Route setup/config edits to the selected profile config and selected profile `.env` or `auth.json` as appropriate.

Current Onboarding Wizard sequence should remain conceptually close to:

1. Setup detection.
2. Profile bootstrap.
3. Welcome.
4. Language and style.
5. Workspace.
6. Workspace trust.
7. Model route.
8. Safety.
9. Agent Evolution.
10. Optional capabilities.
11. Summary.
12. Apply.
13. Launch.

Setup surfaces:

- Onboarding Wizard is the first-run user path.
- Setup Editor is the broader operator path for configured, degraded, repair, untrusted, or state-not-writable states.
- The wizard shows `summary -> confirm -> apply -> verify`, not the full technical manifest as a separate user screen.
- The Setup Editor may expose primary model route, fallback route, auxiliary routes, security mode, Agent Evolution, optional capabilities, verification, and launch-after-verification.
- In the Onboarding Wizard, optional capabilities are limited to Channels, Voice STT/TTS, Browser, and Skip. Vision/image generation belongs in the Setup Editor, not the first-run optional capability menu.
- No setup step should print raw secrets, token prefixes/suffixes, hashes, partial keys, or token-derived identifiers.
- Cancellation and blocked apply must not write secrets.
- Verification after apply is read-only.
- Workspace trust is required before EstaCoda can run in that workspace. If trust is deferred, setup may be saved, but launch must remain blocked.

Profiles are an advanced CLI concept. `estacoda profile use <id>` changes the active profile. A global `--profile <id>` or `-p <id>` flag must be command-local and must not mutate `active-profile.json`.

Changing the setup sequence requires docs updates and smoke coverage.

## Arabic and bidirectional text

Arabic and mixed RTL/LTR rendering quality is a product requirement.

When touching Arabic copy or mixed Arabic and English CLI text:

1. Use correct direction handling.
2. Isolate technical tokens such as API key names, commands, paths, provider names, and model names.
3. Do not translate environment variable names.
4. Do not translate shell commands.
5. Do not translate file paths.
6. Keep Arabic UX clear, not ornamental.
7. Test mixed Arabic and English output manually when possible.
8. Preserve visual alignment, not only logical string order.

Examples of technical tokens that should remain stable:

```text
KIMI_API_KEY
Telegram
~/.estacoda/profiles/default/config.json
pnpm run smoke
kimi-k2
GPT-5.5
```

## Intent router rules

The intent router affects tool exposure, skill selection, safety posture, and user experience.

When changing intent routing:

1. Keep routing explainable.
2. Prefer explicit labels over vague semantic buckets.
3. Preserve negative patterns.
4. Avoid routing that activates powerful tools on weak signals.
5. Add regression tests for ambiguous inputs.
6. Add tests for false positives and false negatives.
7. Do not let provider output bypass deterministic safety gates.
8. Keep Arabic and mixed-language routing in scope if the change touches language detection.

Routing should not be treated as a cosmetic classifier. It is part of the permission system.

## Skills

Built-in source skills live under:

```text
skills/official/<skill-name>/SKILL.md
```

A skill may include:

```text
SKILL.md
references/
templates/
scripts/
assets/
```

`SKILL.md` must start with JSON frontmatter between the first two `---` delimiters. This is JSON parsed with `JSON.parse`, not YAML.

Minimum shape:

```json
{
  "name": "Display Name",
  "description": "Short public description.",
  "routing": {
    "labels": ["example-label"],
    "triggerPatterns": [{ "type": "contains", "value": "example" }],
    "confirmation": "policy"
  },
  "requiredToolsets": ["files"],
  "optionalToolsets": [],
  "playbook": [],
  "evaluations": []
}
```

The loader supplies defaults for some omitted fields, but source skills should follow the documented catalog shape unless there is a reason not to.

Rules for skill contributions:

1. Use `playbook`, not `workflow`. The loader rejects `workflow`.
2. Keep descriptions concise and capability-focused.
3. Declare required and optional toolsets clearly.
4. Do not hide network access, command execution, filesystem writes, or credential needs.
5. Scripts must live under the skill's `scripts/` directory and be inspectable before execution.
6. References should support execution; do not dump context.
7. Templates should be safe to copy and fill.
8. Binary or generated assets should be documented as assets, not presented as readable text.
9. After changing source skills, run `pnpm run skills:catalog` if the public catalog output is expected to change.
10. Do not claim a toolset exists without checking the current registry/contracts.
11. Heavy or niche skills should not become default runtime load unless that is explicitly reviewed.

## Agent Evolution

Agent Evolution is the reviewable self-improvement control plane. The persisted compatibility key remains `skills.autonomy`, but setup and docs should call the user-facing feature Agent Evolution.

Learning must remain reviewable.

Rules:

1. Observations are not automatically trusted.
2. Proposed patches are not automatically accepted.
3. Proposed changes must carry enough evidence to review.
4. Promotion runs available gates; failing gates block promotion.
5. Skill evals are currently metadata/workflow-scoring only. Do not assume real task fixture execution exists unless you add and verify it.
6. Medium-risk, high-risk, and untrusted-source proposals require explicit approval.
7. Learned behavior must not weaken security policy.
8. Learned behavior must not silently store sensitive user information.
9. Learned behavior must not promote provider hallucinations into durable instructions.
10. Bundled and external skill assets are not mutated directly; local/profile-owned copies may shadow.
11. Current autonomous mode is shadow-only unless code and docs explicitly prove otherwise. Do not add auto-promotion, auto-rollback, or live mutation by implication.

The governed loop is:

```text
observe -> propose -> gate/evaluate -> review -> approve or reject -> promote or rollback metadata
```

Do not collapse this into automatic mutation of live skills.

## Tool execution

Tools are the boundary between model output and real-world action.

Rules:

1. Tool schemas must be accurate.
2. Tool names must not imply unavailable capabilities.
3. Tool descriptions must not reference tools that may not be enabled.
4. Tool handlers must validate inputs.
5. Tool handlers must return structured errors.
6. Tool handlers must not leak secrets.
7. Tool handlers must respect workspace trust.
8. Tool handlers must respect approval mode.
9. Tool handlers must avoid shell injection.
10. Tool handlers must avoid path traversal.

If a tool executes commands, writes files, sends messages, performs network access, starts browser/cloud sessions, installs dependencies, or mutates persistent state, assume it needs explicit security review.

## Command execution, security modes, and approvals

Command approval logic must fail closed.

Supported security modes:

- `strict` — asks for approval on almost all tool executions after the hardline floor.
- `adaptive` — default; deterministic triage first, then optional shared smart assessor for ambiguous destructive-local cases.
- `open` — minimal gating for non-hardline actions, but the hardline floor still applies.

Rules:

1. Destructive commands require approval unless the hardline floor denies them outright.
2. Ambiguous commands should not be auto-approved.
3. Approval bypasses must be narrow and tested.
4. False-positive allowances must not become broad allowlists.
5. Normalization must not remove dangerous meaning.
6. Shell metacharacters require careful handling.
7. Commands created by provider output are not trusted just because they look simple.
8. Commands embedded inside `python -c`, `node -e`, `bun -e`, `sh -c`, or similar wrappers must be treated carefully.
9. Any `assessCommandSafety(...).hardBlock` is non-overridable. Severity is metadata, not overrideability.
10. Hardline checks must run before grants, persisted approvals, smart assessors, gateway queue approvals, inline actions, `/yolo`, `open` mode, and final tool execution.
11. Container or non-host environment types may bypass only non-hardline `destructive-local` detections. Never add heuristic container detection from `/proc/1/cgroup` or `/.dockerenv`.
12. Smart approval must use the shared assessor path and Providers Pass D `auxiliaryModels.assessor` route. Do not reintroduce an `approval` auxiliary route or provider/model fallback assessor builder.

Do not add broad patterns like this without strong tests:

```text
echo|printf|python -c|node -e|bun -e
```

Those wrappers can contain dangerous behavior.

## Gateway and messaging rules

Gateway integrations are remote control surfaces.

When touching gateway or messaging code:

1. Verify authentication behavior.
2. Verify session ownership behavior.
3. Verify command routing behavior.
4. Verify approval and denial messages can still interrupt active work.
5. Verify stop, status, queue, approve, and deny commands bypass normal blocked-message queues when necessary.
6. Do not let arbitrary chats control a workspace.
7. Do not expose local files through messaging attachments unless explicitly allowed.
8. Keep outbound media directories constrained.
9. Do not assume Telegram, WhatsApp, Discord, Email adapter paths, or future adapters share the same semantics.
10. Keep `ChannelGateway` as the approval orchestrator: auth, chat/session scope, remote `/approve` and `/deny`, inline action routing, durable queue resolution, continuation resume/termination, persistent grants, and runtime-cache invalidation.
11. Do not mutate `GatewayApprovalQueue` from adapters.
12. Do not authorize approvals, persist grants, or call `RuntimeCache.invalidate(...)` from adapters.
13. Pending gateway approvals are ask-only. Deterministic deny and hardline decisions must never become durable approval rows.
14. Network-facing adapters must deny by default unless an allowlist, pairing policy, or explicit open policy is configured.
15. Session identifiers and surface pointers are routing handles, not authorization boundaries.

External surfaces include CLI handoff, Telegram, WhatsApp, Discord, Email adapter paths where enabled/configured, gateway service mode, browser automation, MCP servers, and any future API surface.

WhatsApp uses `scripts/whatsapp-bridge/`. Baileys account/platform risk is external, but bridge isolation, bearer-token handling, loopback binding, media path policy, aliasing, authorization, and profile state are EstaCoda security surfaces.

Voice notes, text messages, slash commands, and file attachments are different input classes. Handle them separately.

## Browser, web, and URL safety

Browser and web tools cross network and local/private boundary lines.

Rules:

1. Browser navigation requires `http` or `https` unless a specific code path documents otherwise.
2. Private and internal URLs are blocked by default unless explicitly allowed.
3. Cloud metadata endpoints remain hard-blocked.
4. Unsafe redirects must not silently bypass URL policy.
5. Browserbase credentials do not authorize billable session creation. Cloud session creation requires explicit cloud-spend approval.
6. Browser and web routing must not fall back from a denied cloud route to an unsafe local/private route.
7. Website/domain blocklists and allowlists are security-sensitive.
8. `browser.cdp` remains approval-gated by default.

## Managed Python and local capability dependencies

Managed Python environments and downloaded local models are local operator-controlled dependency surfaces.

Rules:

1. Skills may request registered Python capabilities by ID.
2. Skills must not define arbitrary packages, imports, install commands, paths, or versions.
3. Provider output and generated shell text must never become package-install instructions.
4. Package/model downloads are explicit operator actions through setup or upgrade flows.
5. Python environment diagnostics must be bounded and redacted.
6. Managed Python/model/cache paths are security-sensitive and must not be moved into the repo.

## Memory rules

Memory affects future behavior. Treat it as durable execution context.

Rules:

1. Do not store secrets in memory.
2. Do not store sensitive personal data unless the user explicitly requests it.
3. Do not promote one-off preferences into durable memory.
4. Do not let retrieved memory override security policy.
5. Do not let retrieved memory override repo instructions.
6. Keep memory retrieval bounded and relevant.
7. Preserve session summaries when compressing context.
8. Keep prompt packing deterministic enough to test.
9. Keep profile-local memory profile-local unless explicitly using the global shared memory surface.

Memory can improve workflow continuity. It must not become an uncontrolled hidden instruction channel.

## Prompt and context rules

Provider prompts are part of the runtime contract.

Rules:

1. Do not alter core system context mid-session unless the architecture explicitly supports it.
2. Prefer deferred changes for skills, tools, and prompt-affecting config.
3. If immediate invalidation is supported, make it explicit.
4. Keep prompt packing stable.
5. Do not inject full resources when metadata is enough.
6. Use progressive disclosure for skills and resources.
7. Do not let documents, web pages, issue comments, or skill references override higher-priority instructions.
8. Redact supported logs/persistence surfaces, but do not claim arbitrary model-generated final text is guaranteed redacted unless code enforces it.

Prompt injection is expected input, not an edge case.

## Provider and model configuration

Provider configuration should be explicit and reversible.

Rules:

1. Keep primary, fallback, and auxiliary model logic separate.
2. Do not assume a provider supports all tool-calling modes.
3. Do not assume all models support reasoning, images, audio, or JSON output.
4. Keep provider display names separate from provider IDs.
5. Keep model display names separate from model IDs.
6. Validate required credentials before claiming setup success.
7. Support API-key, OAuth, and `authMethod: "none"` routes according to provider metadata and runtime credential resolution.
8. Avoid hardcoded provider assumptions in unrelated code.
9. Use Providers Pass D auxiliary route names as implemented. Security assessment uses `auxiliaryModels.assessor`; do not add or document `auxiliaryModels.approval`, `models.auxiliary`, `auxiliary.default`, or `auxiliary.contextualize` as supported routes.
10. Profile context wording should use `--profile-context`, not `--contextualize`.

Provider failures should degrade clearly, not silently route to unsafe defaults.

## UI, rendering, and theme rules

Terminal UI changes must be boringly reliable.

Rules:

1. Centralize reusable UI primitives.
2. Avoid copy-pasted selector logic.
3. Avoid terminal-control sequences that are known to render literally in common terminals.
4. Reserve enough vertical space before redrawing menus.
5. Keep colors configurable where reasonable.
6. Do not break screen readers or plain terminal output for visual polish.
7. Do not add decorative output that obscures errors, approvals, or security warnings.
8. Preserve renderer behavior across plain, standard, no-Unicode, no-color, narrow-width, and RTL/mixed-language surfaces where relevant.

Brand taste is acceptable. Ambiguous control flow is not.

## Documentation rules

Docs should match implemented behavior.

Update docs when a change affects:

1. Installation.
2. Onboarding or Setup Editor behavior.
3. Configuration.
4. Security posture.
5. Tool behavior.
6. Skill format or skill catalog output.
7. Agent Evolution behavior.
8. Public contribution process.
9. Release process.
10. User-facing commands.
11. Gateway/channel behavior.
12. Browser, web, voice, image, or Python capability setup.

Specific rules:

- Do not document planned behavior as if it already works. Mark planned behavior clearly.
- If changing source skills or skill frontmatter, check whether `website/static/api/skills.json` and `website/static/api/skills-meta.json` need regeneration.
- If changing setup behavior, update the setup subsystem docs and user-facing setup docs.
- If changing security boundaries, update `SECURITY.md` and security docs.
- If changing channel behavior, update channel subsystem docs and operations docs where applicable.
- Public docs must not claim unimplemented capabilities; roadmap behavior belongs in roadmap/planning docs.

## Tests

Prefer behavior tests for runtime contracts. Use renderer snapshots intentionally for terminal UI surfaces where layout, theme fallback, Unicode fallback, plain output, narrow width, Arabic/RTL handling, or no-color behavior is the contract.

Good behavior tests assert contracts:

```text
unsafe commands require approval
workspace writes require trust
missing credentials disable a capability cleanly
Arabic technical tokens remain isolated
skill proposals cannot promote without review
intent router does not activate terminal tools for weak signals
```

Good renderer snapshot tests assert visible UI contracts:

```text
plain renderer has no ANSI
standard dark/light render consistently
no-Unicode terminals avoid box drawing
narrow width wraps safely
Arabic/LTR technical tokens remain isolated
```

Bad change-detector tests assert incidental state:

```text
exact number of supported providers
exact number of skills
exact ordering of unrelated config keys
config version literals
snapshots whose only purpose is freezing incidental copy
```

When adding tests:

1. Keep fixtures small.
2. Use temp directories.
3. Do not touch the real home directory.
4. Do not require live API keys.
5. Do not require network access unless the test is explicitly integration-gated.
6. Test both success and denial paths for security-sensitive changes.
7. Exercise real imports and realistic paths for config, security, setup, lifecycle, and gateway changes where practical.

## Pull request expectations

Every PR should state:

1. What changed.
2. Why it changed.
3. Whether an AI agent contributed.
4. Whether security-sensitive areas were touched.
5. What tests or checks were run.
6. What was not tested.
7. Any follow-up work.

For agent-generated PRs, include:

```text
Agent used:
Scope given to agent:
Files changed by agent:
Human review performed:
Checks run:
Known risks:
```

Agent involvement is not a problem. Hidden agent involvement is a problem.

## Branch and merge discipline

Use focused branches.

Recommended branch names:

```text
fix/setup-selector-redraw
feat/skill-review-proposals
docs/security-model
chore/ci-typecheck
```

Rules:

1. Do not stack unrelated changes in one branch.
2. Rebase or merge from main before final review.
3. Review the final diff after resolving conflicts.
4. Watch for stale branches overwriting recent fixes.
5. Prefer squash merges for small focused PRs unless maintainers decide otherwise.
6. Do not merge failing CI.

Before merging, inspect:

```bash
git diff origin/main...HEAD
```

After merging, inspect the merge result if the branch was stale or conflict-heavy.

## Dependency rules

New dependencies create maintenance and security obligations.

Before adding one:

1. Check whether the standard library or existing dependency is enough.
2. Check package health.
3. Check license compatibility.
4. Check install size.
5. Check transitive dependency risk.
6. Check whether it works in the supported runtime.
7. Add docs if users must install system packages.
8. Check whether the dependency belongs in root runtime, website, WhatsApp bridge, managed Python, or another isolated surface.

Do not add dependencies for small convenience wrappers.

## CI rules

CI should protect the main branch without becoming noise.

CI should eventually cover:

```text
typecheck
unit tests
smoke tests
lint or formatting check
secret scanning
install script check
docs link check
security-sensitive regression tests
```

Do not weaken CI to merge a change. Fix the change or quarantine the flaky test with a clear issue.

## Install, update, uninstall, and release rules

Release and lifecycle automation is high risk.

When touching release, install, update, or uninstall scripts:

1. Treat the change as security-sensitive.
2. Managed-source updates may mutate only the managed install path and must respect installer ownership metadata.
3. Manual source checkouts are operator-owned and should not self-mutate as managed installs.
4. Package-manager and container installs should route updates/removals through their package/container tooling.
5. Uninstall preserves user data by default unless the operator explicitly requests purge behavior.
6. Bugs that write outside the selected install method's ownership boundary are security-sensitive.
7. Avoid piping remote scripts without clear user-facing warnings.
8. Verify checksums or signed artifacts where supported.
9. Keep version changes explicit.
10. Keep release notes factual.
11. Do not publish from a dirty worktree.
12. Do not include secrets in build logs.
13. Version resolution and update diagnostics must redact tokens and private remote URLs.

## Known pitfalls

### Do not broaden security false-positive bypasses

False-positive handling must stay narrow. A pattern that auto-approves wrappers like `python -c`, `node -e`, or `bun -e` can become a command execution bypass.

### Do not use YAML skill frontmatter

EstaCoda source skills use JSON frontmatter. `workflow` is stale; use `playbook`.

### Do not make Agent Evolution live self-mutation

Learning is useful only if reviewable. Current autonomous mode is shadow-only unless code and docs explicitly prove otherwise. Automatic skill, prompt, memory, or runtime policy mutation turns user behavior and provider output into uncontrolled policy.

### Do not confuse Onboarding Wizard with Setup Editor

The wizard is intentionally shorter. Vision/image generation belongs in Setup Editor, not the first-run optional capability menu.

### Do not assume API keys are the only credential type

OAuth uses profile-local `auth.json`; `authMethod: "none"` routes need no credential.

### Do not break terminal selector redraw

Interactive selectors must own their redraw region. Later setup selectors may appear low enough in the terminal to cause scroll, which can break cursor restore.

### Do not claim full Arabic localization prematurely

Localized setup copy is not the same as full runtime localization. Still preserve Arabic shaping, bidi isolation, and mixed-token rendering when touching relevant UI.

### Do not hardcode real user paths

Never commit real machine-specific paths. Use placeholders like:

```text
/path/to/workspace/...
/tmp/example/...
```

Use examples, config values, or temp paths.

### Do not let gateway commands get stuck behind active-session queues

Control commands must reach the runner even when an agent is active.

### Do not turn docs into aspirations

Public docs must reflect reality. Roadmap belongs in roadmap/planning docs, not in operational docs.

### Do not treat renderer snapshots as automatically bad

Behavior snapshots are risky when they freeze incidental state. Renderer snapshots are valid when terminal layout, theme fallback, Unicode fallback, plain output, narrow width, or Arabic/RTL behavior is the contract.

### Do not route setup writes around reviewed apply

Setup mutation belongs behind draft, manifest, plan, review, and apply paths.

### Do not claim public channels are equally mature

Frame channels according to current maturity and configuration. Telegram and WhatsApp may be described as live-proven when that remains true; Discord and Email-style paths should be described according to current implementation and verification status. Do not turn adapter existence into a live-proven product claim.

## When a task is unclear

For small ambiguity, inspect the code and make the safest narrow assumption.

For security ambiguity, stop and require maintainer review.

For product ambiguity, avoid irreversible changes and document the assumption in the PR.

## Minimum handoff format

When handing work to another agent or maintainer, use this format:

```markdown
## Summary
- Changed:
- Why:

## Files touched
- path: reason

## Validation
- command: result

## Security notes
- Sensitive surfaces touched:
- Approval/trust impact:
- Secret-handling impact:

## Remaining work
- Item:
```

## Final rule

Do not optimize for looking productive. Optimize for leaving a safe, reviewable, working patch.
