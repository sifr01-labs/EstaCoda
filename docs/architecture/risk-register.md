---
title: "Architecture Risk Register"
description: "Identified architecture risks, severity, and mitigations."
---

# Architecture Risk Register

| ID | Risk | Severity | Likelihood | Impact | Status | Mitigation |
|----|------|----------|------------|--------|--------|------------|
| R01 | **AgentLoop monolith** | Critical | High | High | **Resolved** | Decomposed from ~2,700 → 829 lines. Router, planner, executor, recorder extracted. |
| R02 | **create-runtime god factory** | High | High | Medium | **Accepted** | 916 lines, 72 imports. Builder/DI deferred to post-MVP. |
| R03 | **No unit tests** | Critical | High | High | **Resolved** | Node/Vitest is the authoritative unit-test lane, with smoke and eval fixtures as integration/regression coverage. |
| R04 | **Bun lock-in prevents Node deployment** | High | Medium | Medium | **Resolved** | Node >= 22.18.0, pnpm/Corepack, compiled `dist/`, and `better-sqlite3` adapter are now the default runtime path. Bun is optional only. |
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
| R19 | **systemd user services stop on logout** | Medium | Medium | Medium | **Accepted** | Install output and operator docs warn that headless Linux hosts may need `sudo loginctl enable-linger $USER`. |
| R20 | **Service environment omits shell secrets** | High | Medium | High | **Accepted** | Services set explicit `HOME`/`PATH` but do not inherit interactive shell exports. Operators must place bot tokens and provider API keys in `~/.estacoda/profiles/<profileId>/.env`. |
| R21 | **Source-mode service path drift** | Medium | Medium | Medium | **Accepted** | Source-mode units hardcode the workspace path. Install output and docs tell operators to reinstall if the repo moves. |
| R22 | **System service privilege boundary** | High | Low | High | **Mitigated** | System installs require root for installation and explicit `--run-as-user <user>` for runtime execution; units include `User=<runAsUser>` and explicit `HOME`. |
| R23 | **Service-aware lifecycle gap** | Medium | Medium | Medium | **Partial** | `gateway stop` and `gateway restart` now delegate to installed user-scope services and require `--system` for system-scope services. `gateway start` remains process-oriented in v0.1.0. |
| R24 | **Service manager probe failures obscure state** | Low | Medium | Low | **Mitigated** | `probeServiceState` never throws; `gateway status` remains usable and reports unknown/not-installed state when systemd/launchd probing fails or is permission-limited. |
| R25 | **Voice gateway media side effects** | High | Medium | High | **Mitigated** | Gateway STT preprocessing validates allowed profile-local roots, type/size, provider readiness, and faster-whisper download policy before side effects; audit JSONL records allow/deny/fail outcomes without private paths. |
| R26 | **Optional Discord voice dependency drift** | Medium | Medium | Medium | **Accepted** | Discord text startup must work without optional voice packages. `/voice channel` returns structured setup errors until the operator installs the voice stack and grants intent/permissions. |

## Risk Heat Map

| | Low Likelihood | Medium Likelihood | High Likelihood |
|---|----------------|-------------------|-----------------|
| **Critical Severity** | — | — | — |
| **High Severity** | R22 | R20, R25 | R02 |
| **Medium Severity** | R07, R12 | R15, R19, R21, R23, R26 | R05 |
| **Low Severity** | R16, R17 | R13, R18, R24 | R10 |

## Summary

- **Resolved (8):** R01, R03, R04, R06, R08, R09, R11, R14
- **Partially resolved (3):** R05, R10, R23
- **Mitigated (3):** R22, R24, R25
- **Mitigation in progress (0):** —
- **Accepted (12):** R02, R07, R12, R13, R15, R16, R17, R18, R19, R20, R21, R26
