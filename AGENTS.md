# AGENTS.md

Development guide for human contributors and AI coding agents working on EstaCoda.

This file is operational instruction. It is not product marketing, roadmap prose, or contributor onboarding. Use it when changing code, reviewing agent-produced patches, or handing work from one agent to another.

## Core rule

Make the smallest correct change that preserves the safety model.

EstaCoda is agent infrastructure. A small bug can become remote code execution, secret exposure, unsafe command approval, poisoned memory, or broken workspace trust. Treat runtime behavior, skills, tools, memory, gateway access, and security policy as sensitive surfaces.

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

## Required workflow for agents

Before editing:

1. Inspect the relevant files.
2. Identify the smallest set of files needed.
3. Check whether the change touches a security-sensitive area.
4. Check whether the change requires docs or tests.
5. Avoid unrelated cleanup.

While editing:

1. Keep commits focused.
2. Do not refactor adjacent code unless it directly reduces risk.
3. Do not update snapshots or expected outputs blindly.
4. Do not introduce new dependencies without a clear reason.
5. Do not edit lockfiles unless dependency changes require it.
6. Do not modify generated files unless the generator was run intentionally.

After editing:

1. Run formatting or linting only where configured.
2. Run the minimum relevant test first.
3. Run the standard validation commands before declaring success.
4. Summarize changed files, checks run, and remaining risks.

## Standard validation commands

Use the commands that exist in the repo. As of the MVP track, the default validation set is:

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
│   ├── browser/               # Browser backend (CDP, Browserbase, etc.)
│   ├── capabilities/          # Capability manifest and trust (stub: capability-setup.ts only)
│   ├── channels/              # Telegram gateway and adapters
│   ├── cli/                   # CLI, interactive session loop, onboarding
│   ├── config/                # Runtime config loading and defaults
│   ├── context/               # Context reference expansion, project context
│   ├── contracts/             # Pure TypeScript types shared across layers
│   ├── cron/                  # Scheduled task store and tools
│   ├── delegation/            # Subagent delegation manager
│   ├── mcp/                   # MCP server integration
│   ├── memory/                # Memory stores, promotion, rendering
│   ├── model-catalog/         # Offline model registry and profiles
│   ├── onboarding/            # First-run setup flows
│   ├── process/               # Process manager and tools
│   ├── prompt/                # Prompt assembly, caching, history packing
│   ├── providers/             # Provider registry, executor, adapters
│   ├── runtime/               # AgentLoop, router, turn loop, tool runner, recorder
│   ├── security/              # Command policy, approvals, trust checks
│   ├── session/               # Session DB (SQLite + in-memory)
│   ├── skills/                # Skill loading, registry, tools, learning, evolution
│   ├── theme/                 # UI theme definitions
│   ├── tools/                 # Tool schemas, registry, executor, planners
│   ├── trajectory/            # Trajectory recorder and persistence
│   ├── types/                 # Additional TypeScript declarations
│   ├── ui/                    # UI labels and settings
│   ├── utils/                 # Shared runtime utilities
│   └── workers/               # Python worker process
├── skills/                  # Built-in (official) skills shipped in repo
├── docs/                    # Architecture, planning, subsystem docs
├── scripts/                 # Project scripts and local utilities
├── .github/                 # CI, issue templates, PR templates
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
└── AGENTS.md
```

If the actual tree differs, follow the actual tree and update this file only when the difference is durable.

## Architecture overview

EstaCoda is a TypeScript-first agent runtime with Node.js as the production runtime, pnpm/Corepack as the source package-manager default, compiled `dist/` as the release target, and Bun as an optional dev-speed lane only.

The main architectural surfaces are:

1. CLI and onboarding.
2. Provider and model configuration.
3. Intent router.
4. Skill system.
5. Tool execution.
6. Security and approval policy.
7. Memory and workflow learning.
8. Gateway and messaging integrations.
9. Documentation and public repo governance.

Agents must avoid treating these as isolated modules. Changes in one layer often affect safety in another layer.

Example: a routing change can cause the wrong skill to load, which can expose the wrong tool, which can trigger the wrong approval path.

## Security-sensitive areas

Treat these as high scrutiny:

```text
src/security/
src/tools/
src/channels/
src/runtime/
src/skills/
src/memory/
src/config/
skills/
.github/workflows/
install scripts
release scripts
```

A change is security-sensitive if it affects any of the following:

1. Command execution.
2. File read or write permissions.
3. Workspace trust.
4. Gateway authorization.
5. Telegram, Discord, or other remote control surfaces.
6. API key handling.
7. Environment variable handling.
8. Skill loading or skill patch promotion.
9. Memory writing, memory retrieval, or prompt packing.
10. Provider prompts or tool schemas.
11. Approval bypasses.
12. Network access.
13. CI secrets or release automation.

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
personal access tokens
private SSH keys
real user config
real logs containing secrets
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

## Runtime state paths

Runtime state should live under an EstaCoda home directory, not hardcoded project paths.

Expected pattern:

```text
~/.estacoda/
├── active-profile.json
├── trust.json
├── workspace-approvals.json
├── sessions.sqlite
├── memory/
│   └── shared/
├── packs/
└── profiles/
    └── <profile-id>/
        ├── config.json
        ├── .env
        ├── auth.json
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

Rules:

1. Do not hardcode a specific user's home path.
2. Do not write tests into the real `~/.estacoda` directory.
3. Use temp directories in tests.
4. Keep project-local fixtures inside the repo.
5. Keep user runtime state outside the repo.
6. Runtime config loads exactly one selected profile config; do not reintroduce user/project config merging.
7. Provider credentials resolve from direct `apiKeyEnv` environment variables; do not reintroduce credential pools.
8. Workspace trust is global directory action trust only. It gates behavior, not config loading.
9. `USER.md`, `SOUL.md`, `MEMORY.md`, and `promotions.json` are profile-local. Global shared memory is only `~/.estacoda/memory/shared/`.

## CLI and onboarding rules

CLI onboarding is a product surface and a trust surface.

When changing CLI or onboarding code:

1. Preserve keyboard navigation.
2. Preserve terminal redraw behavior.
3. Avoid rendering bugs caused by cursor restore after scroll.
4. Keep selector UI centralized.
5. Do not duplicate interactive selector logic across files.
6. Keep language selection early in onboarding.
7. Keep workspace trust explicit.
8. Keep provider setup separate from optional capability setup.
9. Do not imply that skipped optional features are required.
10. Do not claim full runtime localization unless it exists.
11. Keep first-run profile handling silent: onboarding may create/select the default profile behind the scenes, but normal first-run copy should not require profile awareness.
12. Route setup/config edits to the selected profile config and selected profile `.env`.

Current onboarding sequence should remain conceptually close to:

1. Choose interface language and style.
2. Trust this workspace.
3. Choose a primary model provider.
4. Set security and workflow-learning defaults.
5. Connect optional capabilities such as Telegram, voice, and vision.
6. Verify setup.

Profiles are an advanced CLI concept. `estacoda profile use <id>` is the command that changes the active profile. A global `--profile <id>` or `-p <id>` flag must be command-local and must not mutate `active-profile.json`.

Changing this sequence requires docs updates and smoke coverage.

## Arabic and bidirectional text

When touching Arabic copy or mixed Arabic and English CLI text:

1. Use correct direction handling.
2. Isolate technical tokens such as API key names, commands, paths, provider names, and model names.
3. Do not translate environment variable names.
4. Do not translate shell commands.
5. Do not translate file paths.
6. Keep Arabic UX clear, not ornamental.
7. Test mixed Arabic and English output manually when possible.

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

Skills are first-class runtime units.

A skill may include:

```text
SKILL.md
references/
templates/
scripts/
assets/
```

`SKILL.md` should include structured frontmatter where supported:

```yaml
name: example-skill
description: Short description of what the skill does.
version: 0.1.0
category: example
intentLabels:
  - example.intent
triggerPatterns:
  - example phrase
negativePatterns:
  - do not trigger on this
requiredToolsets:
  - filesystem
optionalToolsets:
  - terminal
workflow:
  - inspect
  - act
  - verify
permissionExpectations:
  - requires workspace trust before writing files
evaluations:
  - example-eval
```

Rules for skill contributions:

1. Built-in skills must be broadly useful and low surprise.
2. Heavy or niche skills belong in optional skills.
3. Skills must declare required tools clearly.
4. Skills must not hide network access.
5. Skills must not hide command execution.
6. Skills must not require secrets without declaring them.
7. Scripts inside skills must be inspectable before execution.
8. Binary assets should be described as metadata, not faked as readable text.
9. Templates should be safe to copy and fill.
10. References should be useful, not dumped context.

## Skill learning and evolution

EstaCoda may learn from repeated workflows, propose skill patches, and promote improvements.

Learning must remain reviewable.

Rules:

1. Observations are not automatically trusted.
2. Proposed patches are not automatically accepted.
3. Skill evals must run before promotion where available.
4. Medium-risk and high-risk changes require explicit approval.
5. Untrusted-source proposals require explicit approval.
6. Learned behavior must not weaken security policy.
7. Learned behavior must not silently store sensitive user information.
8. Learned behavior must not promote provider hallucinations into durable instructions.

The lightweight loop is:

```text
observe -> propose -> eval -> review -> approve or reject -> promote
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

If a tool executes commands, writes files, sends messages, performs network access, or mutates persistent state, assume it needs explicit security review.

## Command execution and approvals

Command approval logic must fail closed.

Rules:

1. Destructive commands require approval.
2. Ambiguous commands should not be auto-approved.
3. Approval bypasses must be narrow and tested.
4. False-positive allowances must not become broad allowlists.
5. Normalization must not remove dangerous meaning.
6. Shell metacharacters require careful handling.
7. Commands created by provider output are not trusted just because they look simple.
8. Commands embedded inside `python -c`, `node -e`, `bun -e`, `sh -c`, or similar wrappers must be treated carefully.

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
9. Do not assume Telegram, Discord, or other adapters share the same semantics.

Voice notes, text messages, slash commands, and file attachments are different input classes. Handle them separately.

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

Prompt injection is expected input, not an edge case.

## Provider and model configuration

Provider configuration should be explicit and reversible.

Rules:

1. Keep primary and backup model logic separate.
2. Do not assume a provider supports all tool-calling modes.
3. Do not assume all models support reasoning, images, audio, or JSON output.
4. Keep provider display names separate from provider IDs.
5. Keep model display names separate from model IDs.
6. Validate required API keys before claiming setup success.
7. Avoid hardcoded provider assumptions in unrelated code.

Provider failures should degrade clearly, not silently route to unsafe defaults.

## UI and theme rules

Terminal UI changes must be boringly reliable.

Rules:

1. Centralize reusable UI primitives.
2. Avoid copy-pasted selector logic.
3. Avoid terminal-control sequences that are known to render literally in common terminals.
4. Reserve enough vertical space before redrawing menus.
5. Keep colors configurable where reasonable.
6. Do not break screen readers or plain terminal output for visual polish.
7. Do not add decorative output that obscures errors, approvals, or security warnings.

Brand taste is acceptable. Ambiguous control flow is not.

## Documentation rules

Docs should match implemented behavior.

Update docs when a change affects:

1. Installation.
2. Onboarding.
3. Configuration.
4. Security posture.
5. Tool behavior.
6. Skill format.
7. Agent workflow.
8. Public contribution process.
9. Release process.
10. User-facing commands.

Do not document planned behavior as if it already works. Mark planned behavior clearly.

## Tests

Prefer behavior tests over snapshot tests.

Good tests assert contracts:

```text
unsafe commands require approval
workspace writes require trust
missing credentials disable a capability cleanly
Arabic technical tokens remain isolated
skill patches cannot promote without review
intent router does not activate terminal tools for weak signals
```

Bad tests assert incidental state:

```text
exact number of supported providers
exact number of skills
exact ordering of unrelated config keys
full terminal frame snapshots that change with copy edits
```

When adding tests:

1. Keep fixtures small.
2. Use temp directories.
3. Do not touch the real home directory.
4. Do not require live API keys.
5. Do not require network access unless the test is explicitly integration-gated.
6. Test both success and denial paths for security-sensitive changes.

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
fix/onboarding-selector-redraw
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

## Release rules

Release automation is high risk.

When touching release or install scripts:

1. Treat the change as security-sensitive.
2. Avoid piping remote scripts without clear user-facing warnings.
3. Verify checksums or signed artifacts where supported.
4. Keep version changes explicit.
5. Keep release notes factual.
6. Do not publish from a dirty worktree.
7. Do not include secrets in build logs.

## Known pitfalls

### Do not broaden security false-positive bypasses

False-positive handling must stay narrow. A pattern that auto-approves wrappers like `python -c`, `node -e`, or `bun -e` can become a command execution bypass.

### Do not make skill learning automatic promotion

Learning is useful only if reviewable. Automatic skill mutation turns user behavior and provider output into uncontrolled runtime policy.

### Do not break terminal selector redraw

Interactive selectors must own their redraw region. Later onboarding selectors may appear low enough in the terminal to cause scroll, which can break cursor restore.

### Do not claim full Arabic localization prematurely

Localized onboarding copy is not the same as full runtime localization.

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

Public docs must reflect reality. Roadmap belongs in ROADMAP.md, not in operational docs.

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
