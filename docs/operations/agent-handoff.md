---
title: "Agent Handoff"
description: "Short operational note for incoming coding agents."
---

# Agent Handoff

## Current State

- **Branch:** `main`
- **Version:** v0.7.0
- **Working tree:** Clean expected before handoff

## Standard Validation

```bash
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run eval:fixtures
```

## Security-Sensitive Areas

```
src/security/
src/tools/
src/channels/
src/runtime/
src/skills/
src/memory/
src/config/
skills/
```

## Canonical Docs

- [Architecture](../architecture/overview.md)
- [Subsystems](../subsystems/)
- [Operations](../operations/)
- [ROADMAP.md](../../ROADMAP.md)
- [AGENTS.md](../../AGENTS.md)

## Next Priority

v0.8: Durable TaskFlow — state machines, wait/resume/cancel, flow persistence, approval gates.

See [Prelaunch Milestones](./prelaunch-milestones.md) for full history.
