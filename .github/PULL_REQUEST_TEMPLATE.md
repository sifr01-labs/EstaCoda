# Pull Request

## Summary

Describe what this PR changes and why it matters.

## Type of change

Select all that apply.

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] Tests or evaluation
- [ ] Security hardening
- [ ] CI, build, or tooling
- [ ] Skill, tool, provider, or gateway change
- [ ] Other

## Area touched

Select all that apply.

- [ ] Agent loop or runtime
- [ ] Intent routing
- [ ] Tools or tool execution
- [ ] Skills or skill evolution
- [ ] Providers or model routing
- [ ] Security, approvals, sandboxing, or trust model
- [ ] Memory or persistence
- [ ] CLI or onboarding
- [ ] Gateway or messaging integration
- [ ] Documentation
- [ ] Tests, smoke checks, or evaluation harness
- [ ] Build, packaging, or CI

## Agent involvement

Disclose whether an AI coding agent contributed to this PR.

- [ ] No AI coding agent was used
- [ ] AI coding agent assisted with planning only
- [ ] AI coding agent wrote or modified code
- [ ] AI coding agent wrote or modified documentation
- [ ] AI coding agent generated tests or evaluation cases

Agent used, if applicable:

```text

```

Human review performed:

- [ ] I reviewed every changed file
- [ ] I reviewed security-sensitive changes manually
- [ ] I removed or rejected any speculative agent changes
- [ ] I verified the implementation matches the requested scope

## Security review

Does this PR affect any security-sensitive surface?

- [ ] No
- [ ] Command execution
- [ ] File read/write/delete behavior
- [ ] Path handling or symlink behavior
- [ ] Secrets, credentials, environment variables, or redaction
- [ ] Approval flow or workspace trust
- [ ] Skill loading, skill patches, or skill promotion
- [ ] Provider input/output handling
- [ ] Gateway, Telegram, remote control, or external access
- [ ] Memory, persistence, or learned behavior
- [ ] Dependency, package, or supply-chain behavior

Security notes:

```text

```

## Testing

Commands run:

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

Additional tests, if any:

```bash

```

Results:

- [ ] Node and pnpm versions match the supported runtime contract
- [ ] Frozen pnpm install passed
- [ ] Typecheck passed
- [ ] Unit tests passed
- [ ] Source smoke checks passed
- [ ] Build and dist smoke checks passed
- [ ] Runtime import and emitted ESM audits passed
- [ ] Whitespace/diff check passed
- [ ] Tests were added or updated where needed
- [ ] No real provider API calls are required for tests
- [ ] No secrets or local environment files are committed

## Documentation

- [ ] Documentation is not needed for this change
- [ ] README updated
- [ ] CONTRIBUTING updated
- [ ] SECURITY updated
- [ ] AGENTS updated
- [ ] docs/ updated
- [ ] Comments or inline explanations added where useful

## Breaking changes

Does this PR introduce a breaking change?

- [ ] No
- [ ] Yes

If yes, describe the migration path:

```text

```

## Checklist

- [ ] PR is narrowly scoped
- [ ] No unrelated formatting churn
- [ ] No generated files committed unless intentional
- [ ] No `node_modules/`, `.env`, logs, build output, or local machine files committed
- [ ] New behavior has tests, smoke coverage, or clear manual validation
- [ ] Error handling is explicit
- [ ] User-facing behavior is documented where relevant
- [ ] Security-sensitive behavior is conservative by default
- [ ] This PR is ready for maintainer review
