---
title: Maintenance
description: Documentation governance, public/private boundaries, and claim discipline.
sidebar_position: 3
---

# Maintenance

EstaCoda has two documentation trees: public-facing Docusaurus docs and internal planning artifacts. This page explains the boundary, the migration rules, and why public claims are controlled by release scope.

## Public docs tree

The canonical public documentation lives in:

```text
website/docs/
website/i18n/ar/docusaurus-plugin-content-docs/current/
```

These files are built into the Docusaurus site and shipped with the release. They are the only claims a user should encounter.

Historical ADR pages were removed after they drifted; current subsystem documentation and code are canonical.

## Internal planning artifacts

Raw planning docs live under:

```text
docs/operations/
docs/subsystems/
docs/planning/
```

These are working artifacts, not canonical documentation. They exist for engineering continuity, release-control, and internal assessment. They are not guaranteed to be current, accurate for end users, or safe to quote in public.

## Public/private boundary

| Public (repo) | Private (workspace) |
|---------------|---------------------|
| Architecture docs | Execution plans |
| Subsystem docs | Internal assessments |
| Operations docs | Alpha runbooks |
| Architecture and subsystem docs | Call graphs, builder assessments |
| Release notes | Detailed milestone planning |
| Security model | Vulnerability drafts |

Execution plans belong in the private workspace, not the public repo.

## Release scope controls public claims

Public docs must match implemented behavior and the accepted release scope for the active release. When the scope changes, the public docs change with it.

Rules:

1. Do not claim a feature is supported merely because it appears in code or registry.
2. Do not claim a provider is live-proven without validation evidence.
3. Do not claim a channel is stable without live operator validation.
4. Do not document experimental surfaces as stable launch guarantees.
5. Do not write final install/update behavior before the implementation lands.

## Updating docs

When changing code:

1. Check if the change affects a canonical public doc.
2. Update the canonical doc. Do not create a parallel duplicate.
3. If the change is a durable architectural decision, update the current architecture, subsystem, operations, or release documentation.
4. If the change is internal planning detail, keep it in the private workspace.
5. Run `pnpm run typecheck` and `pnpm run smoke` before committing doc changes that reference code.

## Generated artifacts

- Graph generation scripts: commit publicly.
- Sanitized dependency-map summary: commit publicly.
- Raw `.json` / `.dot` / `.svg` outputs: exclude via `.gitignore`.
- Local paths and machine references: never commit.

## Handoff material

Do not keep `docs/handoff/` as a folder. Use `docs/operations/agent-handoff.md` instead. Keep it under 50 lines and current.

## What this means for operators

The public docs on the website are the claims that matter for users. Internal release-control artifacts may contain future plans, rejected ideas, or draft language that has not been promoted. Those artifacts do not ship in the public v0.1.0 repository.

## Related docs

- [Known Issues](./known-issues.md) — documented limitations
- [Testing](./testing.md) — validation before doc changes
