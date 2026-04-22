# EstaCoda v2

EstaCoda v2 is the clean platform build described in [`../docs/v2/PRD.md`](../docs/v2/PRD.md).

This workspace is intentionally separate from the v1 codebase so the new runtime can be built without inheriting old provider, prompt, permission, or branding assumptions.

## Direction

- TypeScript-first platform.
- Python-first tool execution lane.
- Language-agnostic, agent-authored skill system.
- Capability-first security.
- Generic channel layer with Telegram as the first adapter.
- Hermes-aligned bounded memory.
- Research/RL-ready trajectory capture.
- Kemet Blue visual identity.

## Early Module Map

```text
src/
  contracts/       Shared interfaces and schemas
  runtime/         Agent loop and orchestration shell
  theme/           Theme definitions
```

## First Proof

The first proof should show:

1. CLI/runtime starts.
2. Provider abstraction accepts a model profile.
3. Tool registry can register and resolve tools.
4. Skills can be loaded from declarative files.
5. Memory files are loaded with bounded budgets.
6. Intent router detects a YouTube knowledge-base task.
7. Trajectory events are recorded.

