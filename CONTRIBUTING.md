# Contributing to EstaCoda

Thank you for contributing.

EstaCoda is agent infrastructure with local file, terminal, browser, provider, channel, memory, skill, and lifecycle surfaces. Contributions should make the runtime more reliable, safer, easier to understand, or easier to maintain. Keep changes small, testable, and reversible.

---

## Development Posture

We value contributions in this order:

1. Bug fixes — crashes, incorrect behavior, data loss, broken setup, regressions.
2. Security hardening — shell command safety, path traversal prevention, workspace trust boundaries, secret redaction, approval logic.
3. Reliability — better error handling, recovery from malformed provider responses, deterministic tool execution, clearer diagnostics.
4. Cross-platform compatibility — macOS, Linux, WSL2, shell behavior across common terminals.
5. Agent and skill playbook improvements — safer skill loading, better intent routing, better evaluation fixtures.
6. Documentation — setup instructions, security explanations, architecture notes, troubleshooting examples.
7. New features — narrow, justified, and linked to an existing gap or limitation.

Good first contributions:

- Fix a reproducible bug.
- Add a missing test or smoke case.
- Improve an unclear error message.
- Improve setup copy.
- Improve documentation for an existing behavior.
- Add a guardrail around an unsafe edge case.

Avoid as first contributions:

- Large architecture rewrites.
- New provider integrations without tests.
- New tools that duplicate existing skill behavior.
- Broad refactors with no user-visible improvement.
- Changes that weaken security prompts, workspace trust, or approval boundaries.

---

## Should this be a skill, tool, setup action, or core runtime change?

Prefer the least permanent surface that solves the problem.

Make it a skill when:

- The behavior can be expressed as instructions, playbook steps, references, templates, or helper scripts.
- It uses existing tools and does not need a new model-visible tool schema.
- It is workflow knowledge rather than new runtime capability.

Make it a setup/editor action when:

- The user is configuring providers, credentials, channels, browser, voice, security mode, Agent Evolution, or optional capabilities.
- The change writes profile config, profile `.env`, or profile `auth.json`.
- The user needs review/apply behavior.

Make it a tool when:

- The model needs a precise model-visible action that cannot be safely represented as a skill.
- The action needs validated inputs, structured errors, bounded output, or custom execution semantics.
- The action crosses a security-sensitive boundary such as filesystem writes, commands, browser sessions, external sends, credential access, or package/model downloads.

Make it core runtime code only when:

- Existing skills, setup actions, tools, and config cannot express the behavior safely.
- The change belongs in routing, approval, provider execution, memory, prompt packing, gateway delivery, lifecycle, or Agent Evolution.

---

## Runtime Requirements

| Requirement | Notes |
|---|---|
| Git | Required for all contribution workflows. |
| Node.js >= 22.18.0 | Production runtime contract. |
| pnpm via Corepack | Use Corepack to activate the pnpm version declared in `package.json`. |
| Python 3.11+ | Optional — for Python-based skills and scripts. |

Bun is not required. Some scripts accept Bun as an optional dev-speed lane, but CI and production run on Node.

---

## Local Setup

### Option A: Development checkout (recommended for contributors)

Clone the repo and build, but do NOT run the setup script yet. The setup
script writes a wrapper to `~/.local/bin/estacoda` and initializes state in
`~/.estacoda` — that is a real user install, not a dev environment.

For isolated dev state, use `ESTACODA_HOME`:

```bash
git clone https://github.com/sifr01-labs/EstaCoda.git
cd EstaCoda
corepack enable
pnpm install
pnpm run build
```

Run dev builds against isolated state:

```bash
ESTACODA_HOME="$HOME/.estacoda-dev" node dist/index.js --help
```

Or create a dev alias in your shell rc:

```bash
alias estacoda-dev='ESTACODA_HOME="$HOME/.estacoda-dev" node /path/to/EstaCoda/dist/index.js'
```

Do not alias directly to `dist/index.js`; run it through `node` unless you are using an installed wrapper.

Then initialize dev state:

```bash
estacoda-dev init
estacoda-dev setup
```

Rules:

- Dev uses `git` and `pnpm run build`.
- Dogfood uses `estacoda update`.
- Never git pull inside your dogfood directory.
- Never run `estacoda update` inside your dev checkout.

### Option B: Quick local wrapper (creates a real user install)

Use this when you want an `estacoda` command on PATH from a local checkout.
This writes state to `~/.estacoda` like a normal user install.

```bash
./scripts/setup-estacoda.sh
```

### Environment and secrets

`.env.example` is a reference list of common environment variables. Do not assume repo-root `.env` is loaded by normal EstaCoda runtime execution.

For normal app execution, secrets come from either:

1. exported shell environment variables, or
2. the selected profile `.env` file:

```text
$ESTACODA_HOME/.estacoda/profiles/<profile-id>/.env
```

For the default isolated dev profile used above, that is usually:

```text
$HOME/.estacoda-dev/.estacoda/profiles/default/.env
```

Recommended dev flow:

```bash
ESTACODA_HOME="$HOME/.estacoda-dev" node dist/index.js setup
```

Or export only the keys needed for the workflow you are testing:

```bash
export OPENROUTER_API_KEY="..."
ESTACODA_HOME="$HOME/.estacoda-dev" node dist/index.js --help
```

Rules:

- Never commit `.env`.
- Never commit real API keys.
- Never paste secrets into issues, pull requests, logs, screenshots, or test fixtures.
- Use obvious placeholders such as `TEST_OPENROUTER_API_KEY` in tests.
- Repo-root `.env` should only be used if a specific script explicitly documents that it reads it.

---

## Architecture map

For detailed agent-facing architecture rules, read `AGENTS.md`.

Common starting points:

| Area | Path |
|---|---|
| CLI and interactive session | `src/cli/` |
| Setup and setup editor | `src/setup/` |
| Runtime loop and tool execution | `src/runtime/`, `src/tools/` |
| Security policy and workspace trust | `src/security/` |
| Provider/model routing | `src/providers/` |
| Profile/global state paths | `src/config/profile-home.ts` |
| Skills and Agent Evolution | `src/skills/`, `src/evolution/` |
| Gateway and channels | `src/gateway/`, `src/channels/` |
| Install/update/uninstall lifecycle | `src/lifecycle/`, `scripts/` |
| Public docs | `website/docs/` |
| Internal/operator docs | `docs/` |

---

## Branch Workflow

Branch from the current `main`. Use short, descriptive names.

```text
fix/setup-selector-redraw
feat/provider-tool-recovery
docs/security-model
test/intent-router-fixtures
refactor/skill-catalog-loader
chore/update-ci
```

Keep pull requests scoped. Do not mix documentation and code churn without a clear reason. One logical change per PR.

Use Conventional Commits:

```text
<type>(<scope>): <description>
```

Common types: `fix`, `feat`, `docs`, `test`, `refactor`, `chore`, `security`.

---

## Validation

Use a quick loop while developing, then run the standard PR lane before asking for review unless the change is docs-only or clearly scoped.

### Quick local loop

```bash
pnpm run typecheck
pnpm run test
```

For cross-subsystem runtime behavior, add:

```bash
pnpm run smoke
```

### Standard PR validation

For normal runtime changes, run:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
git diff --check
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
```

Do not claim validation passed unless the command was actually run.

### Validation by change type

If your change touches the compiled output or distribution:

```bash
pnpm run smoke:dist
pnpm run audit:esm
pnpm run audit:runtime-imports
```

If your change touches install, update, or uninstall behavior:

```bash
pnpm run validate:install
pnpm run validate:source-install
pnpm run validate:uninstall
```

If your change touches packaging:

```bash
pnpm run verify:local-bin
pnpm run pack:dry-run
pnpm run verify:package-bin
```

If your change touches Docker:

```bash
pnpm run validate:docker
```

If your change touches Homebrew handoff:

```bash
pnpm run validate:homebrew
```

If your change touches agent/eval logic:

```bash
pnpm run eval:fixtures
```

If your change touches provider routing, reasoning, continuation, message normalization, or provider tool-calling:

```bash
pnpm run provider:hardening
pnpm exec vitest run <targeted-provider-or-runtime-test>
```

`provider:hardening` may require live provider credentials depending on the path under test. Unit tests should still use mocks and must not require live API keys.

If your change touches install, setup, CLI rendering, terminal behavior, or filesystem paths, test manually in a fresh shell.

---

## Skill contributions

Source skills live under:

```text
skills/official/<skill-name>/SKILL.md
```

`SKILL.md` uses JSON frontmatter between `---` delimiters. It is JSON parsed with `JSON.parse`, not YAML.

Use `playbook`, not `workflow`.

If changing source skills or skill frontmatter, run:

```bash
pnpm run skills:catalog
```

Then inspect generated public catalog files:

```text
website/static/api/skills.json
website/static/api/skills-meta.json
```

Do not claim new toolsets, Python capabilities, network access, or credential requirements without checking the current contracts and setup behavior.

---

## Documentation Contribution Rules

EstaCoda has two documentation surfaces:

- `docs/` — internal, subsystem, operator, architecture, and maintenance docs.
- `website/docs/` — public Docusaurus docs.
- `website/i18n/ar/docusaurus-plugin-content-docs/current/` — Arabic public-doc mirrors.

Update the surface that matches the behavior you changed. Some changes require both internal/operator docs and public docs.

Use this rule of thumb:

| Change touches | Usually update |
|---|---|
| runtime architecture, subsystem contracts, operator behavior | `docs/` |
| user-facing install/setup/commands/features | `website/docs/` |
| launch-critical public English docs | Arabic mirror when applicable |
| security posture | `SECURITY.md`, `docs/`, and public docs if user-facing |
| contributor process | `CONTRIBUTING.md`, PR template if needed |

Documentation must match the current release scope and implemented behavior. Do not document planned behavior that is not yet implemented.

Public docs must not contain marketing language. Use concrete, operator-focused prose. Every page should answer: what is this, why does it exist, when should the user care, how does it behave, what commands or files are involved, what can go wrong, and how does the user recover.

English is the canonical drafting source. Arabic documentation must mirror the full launch set where a launch-critical English page exists.

---

## Cross-platform and shell behavior

EstaCoda targets Node.js runtime behavior across common contributor environments, including macOS, Linux, and WSL2.

When touching paths, terminal behavior, process management, or shell commands:

- Use `node:path` helpers instead of string-concatenating paths.
- Use temp directories in tests.
- Do not assume GNU userland tools are present.
- Do not assume shell aliases, rc files, or interactive terminal state.
- Do not rely on executable bits for built JS entrypoints; run built JS through `node` or an installed wrapper.
- Test install/setup/CLI changes from a fresh shell.
- Keep Arabic, bidi, no-color, narrow-width, and plain-output rendering in mind for terminal UI changes.

---

## Security and Safety Contribution Rules

Hard safety blocks are not optional. Do not bypass or weaken:

- Workspace trust checks
- Tool approval checks
- Path allowlists or denylists
- Secret redaction
- Prompt-injection filters
- Skill source trust logic
- Human review for promoted learned behavior
- Review gates for medium-risk or high-risk changes

Security-sensitive changes include anything touching terminal commands, file reads or writes, workspace trust, tool approvals, approval persistence, gateway approval queues, prompt construction, provider responses, provider credentials, model routing, skill loading, external skill directories, Agent Evolution proposals or promotion, memory promotion, session recall, browser/private URL policy, cloud browser spend, managed Python/model downloads, install/update/uninstall behavior, profile isolation, secrets, or gateway/messaging integrations.

These changes require extra review and must not be bundled with unrelated refactors.

Do not commit generated or private artifacts unless they are explicitly intended for the repo.

---

## Dependency and supply-chain rules

Before adding a dependency:

- Check whether existing code or the Node standard library is enough.
- Prefer small, maintained packages with clear licenses.
- Avoid dependencies for convenience wrappers.
- Explain why the dependency belongs in root runtime, website, WhatsApp bridge, managed Python, or another isolated surface.
- Do not edit lockfiles unless dependency changes require it.
- Do not add install-time network behavior outside reviewed install/update/setup paths.
- Treat GitHub Actions, install scripts, release scripts, and package publishing config as security-sensitive.

---

## Pull Request Expectations

Before opening a pull request, confirm:

- The branch is up to date with `main`.
- All relevant validation scripts pass.
- `git diff --check` reports no whitespace errors.
- The change includes tests or smoke cases where practical.

In the PR description, include:

- What behavior changed and why.
- Which validation commands you ran.
- Known limitations or deferred work.
- Whether the change touches security-sensitive areas.
- Whether docs were updated or why docs are not needed.
- Whether generated files were intentionally changed.
- Whether security-sensitive behavior was tested with safe fixtures.
- Whether no real provider API calls are required for tests.

If an AI coding agent produced or significantly modified the code, disclose it and confirm that a human reviewed the diff manually.

---

## Reporting Issues

Use GitHub Issues for public bugs and feature requests.

Include:

- OS and shell.
- Node and pnpm versions.
- EstaCoda version or commit SHA.
- Exact command run.
- Expected behavior.
- Actual behavior.
- Minimal reproduction steps.
- Relevant logs with secrets redacted.

For security vulnerabilities, follow `SECURITY.md` instead of opening a public issue.

---

## What Not To Do

- Do not claim unsupported providers or channels as stable.
- Do not bypass install ownership checks.
- Do not weaken state preservation.
- Do not commit generated or private artifacts unless intended.
- Do not describe Bun as required for normal development.
- Do not instruct contributors to publish npm packages.
- Do not include release-manager-only steps as normal contributor workflow.

---

## License

By contributing, you agree that your contribution is licensed under the repository license.
