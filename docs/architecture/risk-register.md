---
title: "Architecture Risk Register"
description: "Identified architecture risks, severity, and mitigations."
---

# Architecture Risk Register

| ID | Risk | Severity | Likelihood | Impact | Status | Mitigation |
|----|------|----------|------------|--------|--------|------------|
| R01 | **AgentLoop integration size** | High | High | High | **Accepted** | Provider loop, tool execution, skill playbooks, and native intents are separated, but the turn boundary remains large. Keep changes narrow and covered by runtime tests. |
| R02 | **create-runtime god factory** | High | High | Medium | **Accepted** | Runtime construction remains centralized. Prefer local helpers and existing builders before adding new constructor coupling. |
| R03 | **No unit tests** | Critical | High | High | **Resolved** | Node/Vitest is the authoritative unit-test lane, with smoke and eval fixtures as integration/regression coverage. |
| R04 | **Bun lock-in prevents Node deployment** | High | Medium | Medium | **Resolved** | Node >= 22.18.0, pnpm/Corepack, compiled `dist/`, and `better-sqlite3` adapter are now the default runtime path. Bun is optional only. |
| R05 | **Trajectory/Artifact persistence** | Medium | High | Medium | **Partial** | Trajectories persist to SQLite. ArtifactStore remains in-memory and has no lineage or persistence layer. |
| R06 | **Smoke monolith at 14k lines** | Medium | High | Low | **Resolved** | Smoke cases now live under `src/smoke/`; `src/smoke.ts` is only a dispatcher. |
| R07 | **Capability trust coverage is uneven** | Medium | Low | High | **Accepted** | Pack, skill, tool, and setup permissions have gates, but new capability surfaces still need explicit security review. |
| R08 | **No formal eval runner** | Medium | Medium | Medium | **Resolved** | Eval runner with the default deterministic fixture set is operational. |
| R09 | **Memory rendering is dump-based** | Medium | Medium | Medium | **Resolved** | Selective renderer with fallback rules implemented. |
| R10 | **Provider message content assumes strings** | Low | High | Low | **Partial** | Widened for vision. Some paths still conceptually assume strings. |
| R11 | **AGENTS.md drift** | Low | High | Low | **Resolved** | Updated to match current structure. |
| R12 | **Channel maturity is uneven** | Medium | Low | Medium | **Accepted** | Telegram is the strongest first-party remote channel. Discord and Email are implemented but deployment validation is operator-specific. WhatsApp has external API risk. |
| R13 | **Gateway readiness ≠ liveness** | Low | Medium | Low | **Accepted** | Gateway status reports readiness/configuration; service-manager paths provide stronger process state where installed. |
| R14 | **Skill promotion evals are metadata/playbook-only** | Medium | Medium | Medium | **Accepted** | Default eval fixtures cover skill/evolution behavior, but promotion gates still evaluate skill metadata, playbook expectations, and degraded-behavior assertions rather than executing open-ended task fixtures. |
| R15 | **OpenRouter exactness issues** | Medium | Medium | Medium | **Accepted** | Provider-specific hardening ongoing. |
| R16 | **MCP HTTP transport unproven** | Low | Low | Low | **Accepted** | Smoke-tested but not broadly live-proven. |
| R17 | **Local/Ollama unproven** | Low | Low | Low | **Accepted** | Present but unproven in practice. |
| R18 | **ACP editor polish incomplete** | Low | Medium | Low | **Accepted** | Basic ACP integration exists; editor/process polish still needs operator validation. |
| R19 | **systemd user services stop on logout** | Medium | Medium | Medium | **Accepted** | Install output and operator docs warn that headless Linux hosts may need `sudo loginctl enable-linger $USER`. |
| R20 | **Service environment omits shell secrets** | High | Medium | High | **Accepted** | Services set explicit `HOME`/`PATH` but do not inherit interactive shell exports. Operators must place bot tokens and provider API keys in `~/.estacoda/profiles/<profileId>/.env`. |
| R21 | **Source-mode service path drift** | Medium | Medium | Medium | **Accepted** | Source-mode units hardcode the workspace path. Install output and docs tell operators to reinstall if the repo moves. |
| R22 | **System service privilege boundary** | High | Low | High | **Mitigated** | System installs require root for installation and explicit `--run-as-user <user>` for runtime execution; units include `User=<runAsUser>` and explicit `HOME`. |
| R23 | **Service-aware lifecycle gap** | Medium | Medium | Medium | **Mitigated** | Foreground/debug operation is `gateway run`; persistent operation is an installed service plus `gateway start`. `gateway start`, `gateway stop`, and `gateway restart` delegate to installed user-scope services by default and require `--system` for system-scope services. Detached unmanaged background spawning is no longer the start path. |
| R24 | **Service manager probe failures obscure state** | Low | Medium | Low | **Mitigated** | `probeServiceState` never throws; `gateway status` remains usable and reports unknown/not-installed state when systemd/launchd probing fails or is permission-limited. |
| R25 | **Voice gateway media side effects** | High | Medium | High | **Mitigated** | Gateway STT preprocessing validates allowed profile-local roots, type/size, provider readiness, and faster-whisper download policy before side effects; audit JSONL records allow/deny/fail outcomes without private paths. |
| R26 | **Optional Discord voice dependency drift** | Medium | Medium | Medium | **Accepted** | Discord text startup must work without optional voice packages. `/voice channel` returns structured setup errors until the operator installs the voice stack and grants intent/permissions. |

## Risk Heat Map

| | Low Likelihood | Medium Likelihood | High Likelihood |
|---|----------------|-------------------|-----------------|
| **Critical Severity** | — | — | — |
| **High Severity** | R22 | R20, R25 | R02 |
| **Medium Severity** | R07, R12 | R15, R19, R21, R26 | R05 |
| **Low Severity** | R16, R17 | R13, R18, R24 | R10 |

## Summary

- **Resolved (7):** R03, R04, R06, R08, R09, R11, R14
- **Partially resolved (2):** R05, R10
- **Mitigated (4):** R22, R23, R24, R25
- **Mitigation in progress (0):** —
- **Accepted (13):** R01, R02, R07, R12, R13, R15, R16, R17, R18, R19, R20, R21, R26
