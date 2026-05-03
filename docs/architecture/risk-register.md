---
title: "Architecture Risk Register"
description: "Identified architecture risks, severity, and mitigations."
---

# Architecture Risk Register

| ID | Risk | Severity | Likelihood | Impact | Status | Mitigation |
|----|------|----------|------------|--------|--------|------------|
| R01 | **AgentLoop monolith** | Critical | High | High | **Resolved** | Decomposed from ~2,700 → 829 lines. Router, planner, executor, recorder extracted. |
| R02 | **create-runtime god factory** | High | High | Medium | **Accepted** | 916 lines, 72 imports. Builder/DI deferred to post-MVP. |
| R03 | **No unit tests** | Critical | High | High | **Accepted** | Smoke + 18 eval fixtures are the safety net. Vitest deferred to post-MVP. |
| R04 | **Bun lock-in prevents Node deployment** | High | Medium | Medium | **Accepted** | SQLite abstracted behind `src/session/`. Full Node compat deferred. |
| R05 | **Trajectory/Artifact persistence** | Medium | High | Medium | **Partial** | Trajectory persisted to SQLite. ArtifactStore still thin (56 lines). |
| R06 | **Smoke monolith at 14k lines** | Medium | High | Low | **Resolved** | Deduplicated in v0.6.1. `src/smoke.ts` is now a 9-line dispatcher. |
| R07 | **Capability trust is a stub** | Medium | Low | High | **Accepted** | Manifest schema designed. Full implementation targeted v0.9–v0.10. |
| R08 | **No formal eval runner** | Medium | Medium | Medium | **Resolved** | Eval runner with 18 deterministic fixtures operational. |
| R09 | **Memory rendering is dump-based** | Medium | Medium | Medium | **Resolved** | Selective renderer with fallback rules implemented. |
| R10 | **Provider message content assumes strings** | Low | High | Low | **Partial** | Widened for vision. Some paths still conceptually assume strings. |
| R11 | **AGENTS.md drift** | Low | High | Low | **Resolved** | Updated to match current structure. |
| R12 | **Telegram-only channels** | Medium | Low | Medium | **Accepted** | Targeted for v0.9. |
| R13 | **Gateway readiness ≠ liveness** | Low | Medium | Low | **Accepted** | Targeted for v0.9. |
| R14 | **Skill evals are metadata-only** | Medium | Medium | Medium | **Resolved** | Real task fixtures exist (18 evals). |
| R15 | **OpenRouter exactness issues** | Medium | Medium | Medium | **Accepted** | Provider-specific hardening ongoing. |
| R16 | **MCP HTTP transport unproven** | Low | Low | Low | **Accepted** | Smoke-tested but not broadly live-proven. |
| R17 | **Local/Ollama unproven** | Low | Low | Low | **Accepted** | Present but unproven in practice. |
| R18 | **ACP editor polish incomplete** | Low | Medium | Low | **Accepted** | Terminal/process rendering targeted v0.9. |

## Risk Heat Map

| | Low Likelihood | Medium Likelihood | High Likelihood |
|---|----------------|-------------------|-----------------|
| **Critical Severity** | — | — | R03 |
| **High Severity** | R04 | — | R02 |
| **Medium Severity** | R07, R12 | R15 | R05 |
| **Low Severity** | R16, R17 | R13, R18 | R10 |

## Summary

- **Resolved (6):** R01, R06, R08, R09, R11, R14
- **Partially resolved (2):** R05, R10
- **Accepted (10):** R02, R03, R04, R07, R12, R13, R15, R16, R17, R18
