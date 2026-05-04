---
title: "Architecture"
description: "System structure, runtime composition, data flow, and decomposition targets."
---

# Architecture

This section describes how EstaCoda is structured, how components compose, and where the architecture is healthy vs. strained.

All statements here are grounded in the current codebase. If a feature is not implemented, it is labeled as such.

## Sections

| Doc | Purpose |
|-----|---------|
| [Overview](./overview.md) | High-level system map, entrypoints, composition root, and data flow |
| [Runtime](./runtime.md) | Breakdown of the runtime: AgentLoop, createRuntime, registries, executors |
| [TaskFlow](./taskflow.md) | Durable multi-step execution, state machine, and runtime integration |
| [Evolution](./evolution.md) | Governed skill evolution, AHE alignment, and self-improvement loop |
| [Dependency Map](./dependency-map.md) | Module-level dependency graph with Mermaid visualization |
| [Knowledge Map](./knowledge-map.md) | Runtime concept map with Mermaid visualization |
| [Boundary Maps](./boundary-maps.md) | Cross-subsystem boundary analysis: memory, skills, provider loop, observability |
| [Risk Register](./risk-register.md) | Architecture risks, severity, and mitigation |
