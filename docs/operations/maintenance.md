---
title: "Documentation Governance"
description: "Rules for keeping EstaCoda documentation accurate, navigable, and public-ready."
---

# Documentation Governance

## Core Rules

1. **Execution plans are private workspace artifacts.** They live in the private workspace, not the public repo.
2. **Repo docs should be public-ready unless explicitly marked otherwise.**
3. **Generated artifacts should not be committed unless sanitized and intentionally useful.**
4. **Canonical docs must be updated instead of creating parallel duplicate docs.**
5. **ADRs are for durable architectural decisions only.**
6. **Handoff material must stay short and operational.** It is not a substitute for updating canonical documentation.

## Public/Private Boundary

| Public (repo) | Private (workspace) |
|---------------|---------------------|
| Architecture docs | Execution plans |
| Subsystem docs | Internal assessments |
| Operations docs | Alpha runbooks |
| ADRs | Call graphs, builder assessments |
| Roadmap | Detailed milestone planning |
| Security model | Vulnerability drafts |

## Planning Docs

`docs/planning/README.md` states the rule:

> Planning documents are working artifacts, not canonical documentation. Execution plans should live in the private workspace and should not be committed to the public repo. Durable decisions must be promoted into architecture docs, ADRs, ROADMAP.md, or prelaunch milestone history.

## Handoff Material

Do not keep `docs/handoff/` as a folder. Use `docs/operations/agent-handoff.md` instead. Keep it under 50 lines and current.

## Generated Graphs

- Graph generation scripts: commit publicly
- Sanitized dependency-map.md summary: commit publicly
- Raw `.json` / `.dot` / `.svg` outputs: exclude via `.gitignore`
- Local paths and machine references: never commit

## Updating Docs

When changing code:

1. Check if the change affects a canonical doc.
2. Update the canonical doc, do not create a new one.
3. If the change is a durable architectural decision, consider an ADR.
4. If the change is internal planning detail, keep it in the private workspace.
5. Run `pnpm run typecheck` and `pnpm run smoke` before committing doc changes that reference code.
