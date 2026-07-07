---
title: "Subsystems"
description: "Per-subsystem deep dives for the EstaCoda agent runtime."
---

# Subsystems

| Doc | Scope |
|-----|-------|
| [CLI & Setup](./cli.md) | Commands, interactive session, trace/eval inspection, Onboarding Wizard |
| [Operator Console](./operator-console.md) | Future Papyrus-owned interactive CLI surface contract |
| [Skills](./skills.md) | Skill loading, registry, tools, learning, evolution, proposals |
| [Memory](./memory.md) | Stores, curation, prompt builder, recall orchestration, compaction, external memory |
| [Managed Python Environments](./python-env.md) | Runtime-owned Python dependency environments for capabilities that need pinned packages without mutating system Python |
| [Semantic Session Compression](./semantic-compression.md) | Gated session-history compression, manual compaction, gateway hygiene, safety boundaries |
| [Tools](./tools.md) | Tool schemas, registry, executor, planners |
| [Traces](./traces.md) | Trajectory recording, event kinds, persistence |
| [Evals](./evals.md) | Eval runner, deterministic fixtures, regression detection |
| [Security](./security.md) | Capability-first security, approval modes, hard floor |
| [Providers](./providers.md) | Provider registry, executor, adapters, model catalog |
| [Channels](./channels.md) | Telegram gateway, session mapping, approvals |
| [Voice](./voice.md) | TTS/STT providers, gateway voice policy, CLI voice mode, Discord voice-channel support |
| [Cron](./cron.md) | Scheduled tasks, tick locking, persistence |
| [Browser](./browser.md) | Chrome DevTools Protocol automation |
| [Web Research](./web-research.md) | Search providers, guarded extraction, Brave credentials, DDGS managed Python setup |
| [MCP](./mcp.md) | MCP client for stdio and HTTP servers |
| [ACP](./acp.md) | ACP stdio server foundation for editor clients |
