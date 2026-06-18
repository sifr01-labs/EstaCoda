---
title: "ACP (IDE Integration)"
description: "ACP stdio JSON-RPC server for editor integration."
---

# ACP (IDE Integration)

## Files

| File | Role |
|------|------|
| `src/acp/server.ts` | ACP stdio JSON-RPC server |

## Capabilities

| Method | Status |
|--------|--------|
| `initialize` | `live-proven` |
| `authenticate` | `live-proven` |
| `session/new` | `live-proven` |
| `session/load` | `live-proven` |
| `session/list` | `live-proven` |
| `session/prompt` | `live-proven` |
| `session/cancel` | `live-proven` |
| `session/update` (streaming) | `live-proven` |

## Features

- Cwd-bound ACP sessions mapped onto EstaCoda runtimes
- Editor-backed file reads through ACP fs requests
- Approval bridging for gated shell actions
- `acp_registry/agent.json` manifest

## Live-Proven Flows

- Basic chat in JetBrains
- Editor-backed file reads
- Shell execution with approval prompts
- Permission handshake

## Limitations

- Terminal/process mirror polish is incomplete.
- Richer command/mode/config updates are missing.
- Broader editor support (VS Code, Zed) is not live-proven.
