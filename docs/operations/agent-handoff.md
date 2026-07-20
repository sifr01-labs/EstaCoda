---
title: "Agent Handoff"
description: "Short operational note for incoming coding agents."
---

# Agent Handoff

## Current State

- **Branch:** `main`
- **Release:** v0.1.0 docs and runtime baseline
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
- [AGENTS.md](../../AGENTS.md)

## Current Priority

Keep this note aligned with the release-current architecture, setup, and operations docs. Durable Tasks are the explicit operator surface; use [Durable Task CLI](./task-cli.md) and [Durable Task Architecture](../architecture/workflows.md) for current behavior.

See the Docusaurus operations docs for current public operator guidance.
