---
title: "EstaCoda Documentation"
description: "Source of truth for the EstaCoda agent runtime — architecture, subsystems, operations, and assessments."
---

# EstaCoda Documentation

This directory is the **source of truth** for the EstaCoda codebase as it exists today. It is written for engineers, operators, and coding agents who need to understand, change, or extend the system.

> **Rule:** If the code and the docs disagree, the code is correct. Update the docs.

Historical ADRs were removed after they drifted; current subsystem documentation and code are canonical.

---

## Structure

| Section | Purpose |
|---------|---------|
| [Architecture](./architecture/) | System structure, runtime composition, data flow, evolution, and risk register. |
| [Subsystems](./subsystems/) | Per-subsystem deep dives: skills, memory, security, providers, channels, voice, tools, CLI, traces, evals, cron, browser, MCP, ACP. |
| [Operations](./operations/) | How to set up, test, run smoke, operate voice, perform maintenance, agent handoff, and validate releases. |
| [Memory Operator Readiness](./operations/memory-operator-readiness.md) | Operational guide for Memory Hardening phases 0-10. |
| [Planning](./planning/) | Governance note: planning docs are private workspace artifacts. |
| **UI / CLI (v0.95)** | |
| [UI Architecture](./ui-architecture.md) | ViewModel → Renderer → Surface Adapter pipeline. |
| [Theme & Tokens](./theme-tokens.md) | Semantic token system, light/dark themes, KemetBlue skin, plain mode. |
| [Rendering Guide](./rendering-guide.md) | Contributor guide for adding new CLI surfaces. |
| [Manual QA](./manual-qa.md) | Environment fallback, streaming safety, and visual validation procedures. |

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `corepack enable` | Activate package-manager shims |
| `pnpm install` | Install dependencies |
| `pnpm run typecheck` | TypeScript type check |
| `pnpm run test` | Run the authoritative Node/Vitest test lane |
| `pnpm run smoke` | Run source-mode smoke tests |
| `pnpm run dev` | Start interactive CLI from source |
| `pnpm run build` | Compile production `dist/` output |
| `pnpm run start` | Run the built CLI with Node |
| `pnpm run smoke:dist` | Run smoke tests from `dist/` |
| `pnpm run eval:substrate` | Generate eval run scaffold |
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
