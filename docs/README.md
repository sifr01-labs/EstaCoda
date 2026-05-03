---
title: "EstaCoda Documentation"
description: "Source of truth for the EstaCoda agent runtime — architecture, subsystems, operations, and assessments."
---

# EstaCoda Documentation

This directory is the **source of truth** for the EstaCoda codebase as it exists today. It is written for engineers, operators, and coding agents who need to understand, change, or extend the system.

> **Rule:** If the code and the docs disagree, the code is correct. Update the docs.

---

## Structure

| Section | Purpose |
|---------|---------|
| [Architecture](./architecture/) | System structure, runtime composition, data flow, evolution, and risk register. |
| [Subsystems](./subsystems/) | Per-subsystem deep dives: skills, memory, security, providers, channels, tools, CLI, traces, evals, cron, browser, MCP, ACP. |
| [Operations](./operations/) | How to set up, test, run smoke, perform maintenance, and agent handoff. |
| [ADR](./adr/) | Architectural Decision Records for durable cross-subsystem decisions. |
| [Planning](./planning/) | Governance note: planning docs are private workspace artifacts. |

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun run typecheck` | TypeScript type check |
| `bun run smoke` | Run smoke tests |
| `bun run dev` | Start interactive CLI |
| `bun run eval:substrate` | Generate eval run scaffold |
| `estacoda trace list` | List recent trajectories |
| `estacoda trace dump <id>` | Inspect a trajectory (redacted) |
| `estacoda trace timeline <id>` | Chronological event view |
| `estacoda trace failures <id>` | List classified failures |
| `estacoda eval [fixture-id]` | Run eval fixture |

---

## Evidence Labels

Docs use four verification labels consistently:

| Label | Meaning |
|-------|---------|
| `live-proven` | Verified by a real operator run |
| `smoke-tested` | Covered by `src/smoke.ts` |
| `eval-tested` | Covered by deterministic eval fixtures |
| `implemented but not live-proven` | Code exists, no fresh operator proof assumed |
| `intended but not implemented` | Design target only |

---

## External References

- [`AGENTS.md`](../AGENTS.md) — Development guide for AI coding agents and human contributors
- [`README.md`](../README.md) — Project README
- [`ROADMAP.md`](../ROADMAP.md) — Product roadmap
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — Contribution guide
- [`SECURITY.md`](../SECURITY.md) — Security policy
