# Contributing to EstaCoda

Thank you for contributing to EstaCoda.

This guide explains how to decide what to build, how to set up the project locally, how to work safely with agent-generated code, and how to get a pull request reviewed.

EstaCoda is pre-MVP software. Contributions should make the product more reliable, safer, easier to install, easier to understand, or easier to maintain. Keep changes small, testable, and reversible.

---

## Contribution priorities

We value contributions in this order:

1. Bug fixes
   - Crashes
   - Incorrect behavior
   - Data loss
   - Broken setup or onboarding
   - Regressions in existing CLI, agent, tool, or skill behavior

2. Security hardening
   - Prompt injection resistance
   - Shell command safety
   - Path traversal prevention
   - Workspace trust boundaries
   - Secret redaction
   - Tool approval and permission handling

3. MVP reliability
   - Better error handling
   - Better recovery from malformed provider responses
   - More deterministic tool execution
   - Better smoke coverage
   - Clearer diagnostics through `doctor` commands

4. Cross-platform compatibility
   - macOS
   - Linux
   - WSL2
   - Terminal behavior across common shells

5. Agent and skill workflow improvements
   - Better skill discovery
   - Safer skill loading
   - Better intent routing
   - Better evaluation fixtures
   - Better review and promotion workflows

6. Documentation
   - Setup instructions
   - Contributor guidance
   - Security explanations
   - Architecture notes
   - Troubleshooting examples

7. New features
   - Features should be narrow, justified, and linked to the roadmap.
   - Avoid large speculative rewrites before MVP.

---

## What to work on first

Good first contributions:

- Fix a reproducible bug.
- Add a missing test or smoke case.
- Improve an unclear error message.
- Improve setup or onboarding copy.
- Improve documentation for an existing behavior.
- Add a small guardrail around an unsafe edge case.

Bad first contributions:

- Large architecture rewrites.
- New provider integrations without tests.
- New tools that duplicate existing skill behavior.
- Broad refactors with no user-visible improvement.
- Changes that weaken security prompts, workspace trust, or approval boundaries.

---

## Common contribution paths

### Bug fixes

A strong bug fix includes:

- A clear description of the bug.
- A minimal reproduction.
- A focused code change.
- A test or smoke case when practical.
- A note about security impact if the bug touches commands, files, tools, skills, providers, or memory.

### Documentation

Documentation changes should be direct and verifiable.

Use documentation for:

- Setup steps
- Expected behavior
- Known limitations
- Security boundaries
- Contributor workflows
- Architecture explanations

Do not use documentation to promise features that do not exist.

### Skills

Make something a skill when it can be expressed through:

- Instructions
- Existing tools
- Shell commands
- Templates
- References
- Helper scripts

Skills should be preferred when the capability does not need new runtime primitives.

Bundled skills should be broadly useful. Specialized skills should stay outside the core repo until they have repeated demand and clear maintenance ownership.

### Tools

Make something a tool only when it needs precise runtime behavior that should not depend on model interpretation.

Examples:

- File operations
- Terminal execution
- Provider-facing tool schemas
- Skill inspection
- Security assessment
- Binary or structured data handling
- Gateway integrations
- Anything that manages secrets, permissions, or external auth

A new tool must include:

- A clear schema
- Deterministic behavior
- Error handling
- Security analysis
- Tests or smoke coverage
- Documentation if user-facing

### Providers

Provider changes must preserve the core tool loop.

Provider work should include:

- Schema compatibility notes
- Tool-call behavior notes
- Error recovery behavior
- Live or mocked verification
- No hardcoded provider-specific assumptions unless isolated behind an adapter

### Security-sensitive changes

Security-sensitive changes include anything touching:

- Terminal commands
- File reads or writes
- Workspace trust
- Tool approvals
- Prompt construction
- Provider responses
- Skill loading
- External skill directories
- Memory promotion
- Secrets and environment variables
- Gateway or messaging integrations

These changes require extra review and must not be bundled with unrelated refactors.

---

## Development setup

### Prerequisites

| Requirement | Notes |
| --- | --- |
| Git | Required for all contribution workflows. |
| Node.js | Node >= 22.18.0 is the production runtime contract. |
| Corepack / pnpm | Use Corepack to activate the pnpm version declared in `package.json`. |
| Bun | Optional dev-speed lane only; not required for normal development or production runtime. |
| Python 3.11+ | Optional for Python-based skills, scripts, and compatibility checks. |

### Clone and install

```bash
git clone git@github.com:KemetResearch/estacoda.git
cd estacoda
corepack enable
pnpm install
```

If you are contributing from a fork:

```bash
git clone git@github.com:<your-username>/estacoda.git
cd estacoda
git remote add upstream git@github.com:KemetResearch/estacoda.git
corepack enable
pnpm install
```

### Local environment

If the repo includes an example environment file, copy it:

```bash
cp .env.example .env
```

Then add only the keys needed for the workflow you are testing.

Rules:

- Never commit `.env`.
- Never commit real API keys.
- Never paste secrets into issues, pull requests, logs, screenshots, or test fixtures.
- Use obvious placeholders such as `TEST_OPENROUTER_API_KEY` in tests.
- Prefer local-only config files for provider credentials.

### Run checks

Run the checks that apply to your change.

Minimum local verification:

```bash
pnpm run typecheck
pnpm run smoke
git diff --check
```

If the repo exposes additional scripts, run the relevant ones:

```bash
pnpm run test
pnpm run build
pnpm run smoke:dist
```

If your change touches provider tool-calling, run the relevant live or mocked provider check documented by the repo.

If your change touches install, onboarding, CLI rendering, terminal behavior, or filesystem paths, test manually in a fresh shell.

---

## Project structure

The exact tree will evolve, but contributors should expect the project to be organized around these areas:

```text
estacoda/
├── src/
│   ├── cli/                 # CLI commands, onboarding, terminal UI primitives
│   ├── agent/               # Agent loop, prompt assembly, provider interaction
│   ├── tools/               # Runtime tools exposed to the model
│   ├── skills/              # Skill loading, cataloging, viewing, evaluation
│   ├── security/            # Safety policies, command assessment, trust boundaries
│   ├── memory/              # Persistent memory and learning records
│   ├── providers/           # Model provider adapters and schema normalization
│   └── gateway/             # Messaging or external interface adapters, when enabled
├── skills/                  # Bundled official skills
├── docs/                    # Public documentation and contributor guidance
├── tests/                   # Unit, integration, and fixture-based tests
├── scripts/                 # Repo maintenance and local development scripts
├── AGENTS.md                # Guidance for coding agents and AI assistants
├── CONTRIBUTING.md          # This file
├── SECURITY.md              # Security reporting and trust model
└── README.md                # User-facing project overview
```

Do not move large areas of the codebase without a prior issue or design discussion.

---

## Code style

### TypeScript

- Prefer explicit types at module boundaries.
- Keep functions small.
- Keep side effects isolated.
- Avoid broad `any`.
- Avoid hidden global state.
- Use clear names over clever abstractions.
- Return structured errors where the caller needs to recover.
- Do not swallow errors silently.
- Keep provider-specific logic behind provider adapters.
- Keep security-sensitive checks centralized.

### Comments

Write comments only when they explain:

- Intent
- Trade-offs
- Security reasoning
- Compatibility constraints
- Non-obvious provider behavior
- Why a dangerous-looking operation is safe

Do not narrate obvious code.

### Error handling

Errors should help users and maintainers understand what failed.

Good errors include:

- What failed
- Why it likely failed
- Whether the operation was blocked for safety
- What command or config area to check
- No secrets

### Cross-platform rules

- Use `path` utilities instead of string path concatenation.
- Do not assume `/tmp`, `~`, Bash, GNU utilities, or macOS-only behavior.
- Treat terminal rendering as fragile.
- Keep CLI selectors and redraw logic centralized.
- Avoid hardcoded absolute paths.
- Test file and process behavior on macOS and Linux when touched.

---

## Security rules

EstaCoda is an agent runtime with local file and terminal access. Security is not a feature layer. It is part of the core architecture.

### Required practices

- Validate paths before reading or writing.
- Resolve symlinks before access-control decisions.
- Redact secrets from logs and model-visible text.
- Never print real API keys.
- Keep destructive commands behind approval boundaries.
- Keep workspace trust explicit.
- Treat skill instructions as untrusted unless their source is trusted.
- Treat provider output as untrusted.
- Treat user-provided files as untrusted.
- Treat agent-generated code as untrusted until reviewed.
- Add tests for bypasses where practical.

### Do not weaken these boundaries

Do not bypass or weaken:

- Workspace trust checks
- Tool approval checks
- Path allowlists or denylists
- Secret redaction
- Prompt-injection filters
- Skill source trust logic
- Human review for promoted learned behavior
- Review gates for medium-risk or high-risk changes

### Security reporting

Do not open public issues for vulnerabilities.

Report security vulnerabilities using the process in `SECURITY.md`.

---

## Agent-generated contributions

AI coding agents are allowed, but the human contributor is responsible for the result.

Agent-generated changes must follow the same review standard as human-written code.

### Required agent discipline

- One task per branch.
- One logical change per pull request.
- No unrelated cleanup.
- No broad refactors without prior discussion.
- No generated code that the contributor cannot explain.
- No weakening of security checks to make tests pass.
- No committing secrets, logs, local config, or machine-specific paths.

### Include in the pull request

If an agent produced or significantly modified the code, include:

- The goal given to the agent.
- The files changed.
- The checks run.
- Any known limitations.
- Any security-sensitive areas touched.
- Whether the human contributor reviewed the diff manually.

### Agent review standard

Before submitting, inspect:

```bash
git diff
git status
git diff --check
pnpm run typecheck
pnpm run smoke
```

Do not submit an agent change only because the agent said checks passed. Run the checks yourself or show the CI result.

---

## Branch naming

Use short, descriptive branch names.

```text
fix/onboarding-selector-redraw
feat/provider-tool-recovery
docs/security-model
test/intent-router-fixtures
refactor/skill-catalog-loader
chore/update-ci
```

Preferred prefixes:

| Prefix | Use for |
| --- | --- |
| `fix/` | Bug fixes |
| `feat/` | New user-facing behavior |
| `docs/` | Documentation |
| `test/` | Tests and fixtures |
| `refactor/` | Internal restructuring with no behavior change |
| `chore/` | Maintenance, dependencies, CI |

---

## Commit messages

Use Conventional Commits.

```text
<type>(<scope>): <description>
```

Examples:

```text
fix(cli): prevent selector redraw from scrolling terminal
feat(skills): add proposal review command
docs(security): clarify workspace trust boundary
test(router): add fixture for ambiguous coding intent
chore(ci): add typecheck to pull request workflow
```

Common types:

| Type | Use for |
| --- | --- |
| `fix` | Bug fixes |
| `feat` | New behavior |
| `docs` | Documentation |
| `test` | Tests |
| `refactor` | Code restructuring |
| `chore` | Build, CI, dependency updates |
| `security` | Security hardening |

Common scopes:

```text
cli
agent
tools
skills
security
providers
gateway
memory
docs
ci
install
router
```

---

## Pull request process

### Before opening a pull request

Confirm:

- The branch is up to date with `main`.
- The change is focused.
- The diff contains no secrets.
- Local-only files are not committed.
- Typecheck passes.
- Smoke checks pass.
- The PR includes testing notes.
- Security-sensitive areas are identified.

Recommended flow:

```bash
git fetch upstream
git checkout main
git pull upstream main
git checkout -b fix/short-description
# make changes
pnpm run typecheck
pnpm run smoke
git diff --check
git status
git diff
git add .
git commit -m "fix(scope): short description"
git push origin fix/short-description
```

### Pull request description

Include:

- What changed
- Why it changed
- How to test it
- Which commands were run
- Screenshots or terminal output when relevant
- Related issue, if any
- Security impact, if any
- Agent involvement, if any

### Review expectations

Maintainers may ask for:

- Smaller diffs
- More tests
- Clearer docs
- Safer defaults
- More explicit error handling
- Stronger permission boundaries
- Removal of unrelated changes

Security-sensitive pull requests may require review from a code owner.

---

## Issue reporting

Use GitHub Issues for non-security bugs, feature requests, documentation gaps, and support questions.

A good bug report includes:

- Operating system
- Shell
- Node.js version
- pnpm version
- Bun version, only if using an optional Bun lane
- EstaCoda version or commit
- Install method
- Command run
- Expected behavior
- Actual behavior
- Minimal reproduction
- Logs with secrets removed

For setup issues, include:

```bash
node --version
pnpm --version
git --version
```

Do not paste secrets.

---

## Design proposals

Open a design issue before building:

- New provider support
- New tool categories
- New gateway integrations
- Changes to skill trust or promotion
- Changes to the security model
- Changes to memory persistence
- Large CLI or TUI changes
- Public API changes
- Breaking config changes

A design issue should include:

- Problem
- Proposed behavior
- Alternatives considered
- Security impact
- User impact
- Migration impact
- Test plan

---

## Documentation standards

Documentation should be:

- Accurate
- Current
- Plain
- Verifiable
- Honest about limitations

Avoid:

- Marketing language
- Overclaiming
- Future promises written as current behavior
- Hidden assumptions
- Unexplained jargon
- Commands that have not been tested

When behavior is experimental, label it experimental.

When a command is platform-specific, say so.

---

## License

By contributing to EstaCoda, you agree that your contribution will be licensed under the repository license.
