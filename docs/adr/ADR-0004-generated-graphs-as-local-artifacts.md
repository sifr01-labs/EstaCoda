# ADR-0004: Generated Graphs as Local Artifacts with Public Summaries

**Status:** Accepted  
**Date:** 2026-05-03  
**Scope:** Documentation, tooling, repo hygiene

## Context

Dependency and knowledge graphs are useful for understanding the codebase, but generated artifacts quickly become stale, contain local paths, and bloat the repo.

## Decision

1. **Graph generation scripts are committed publicly.**
2. **Sanitized summaries are committed publicly** (`docs/architecture/dependency-map.md`, `docs/architecture/knowledge-map.md`).
3. **Raw generated outputs are excluded via `.gitignore`.**
4. **Local machine paths, usernames, and private notes never appear in committed docs.**

Generated artifacts go under `.estacoda/graphs/`:

```gitignore
.estacoda/graphs/*.json
.estacoda/graphs/*.dot
.estacoda/graphs/*.svg
```

## Rejected Alternatives

1. **Commit full generated graphs** — Rejected: stale bloat, local path leakage.
2. **No graphs at all** — Rejected: useful for onboarding and architecture review.
3. **Graphs in CI only** — Rejected: local generation is faster and more flexible.

## Consequences

- `tools/graphs/` contains generation scripts.
- `docs/architecture/` contains human-curated summaries.
- Graphs are refreshed during maintenance passes, not every commit.
