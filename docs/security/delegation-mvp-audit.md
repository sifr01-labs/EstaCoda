# Delegation MVP Security Audit

Status: test-backed checklist for the v0.1.0 delegation/Hermes-parity MVP.

This audit covers shipped behavior only. It does not claim cost rollups, memory outcome hooks, stale-file warnings, child provider/model overrides, operator lifecycle/status surfaces, `terminal.inspect`, or parent-mediated child approvals are implemented.

## Checklist

| Item | Required behavior | Coverage |
|------|-------------------|----------|
| Child registry/tool/schema bounds | Child tools are resolved before provider schemas are built and registry entries are stripped. | `src/delegation/toolset-security.test.ts`, `src/delegation/tool-inventory-audit.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Direct stripped tool execution | A stripped tool cannot be resolved/executed from the child registry. | `src/delegation/delegation-mvp-security-audit.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Leaf/orchestrator depth | `leaf` children cannot spawn; `orchestrator` children can spawn only below `maxSpawnDepth`; over-depth fails before child session creation. | `src/delegation/toolset-security.test.ts`, `src/delegation/delegation-manager.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Parent intersection | Children cannot request tools or toolsets that were not visible to the parent. | `src/delegation/toolset-security.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts` |
| Default read-only risk classes | Default child tools are limited to `read-only-local` and `read-only-network` after parent intersection and block stripping. | `src/config/runtime-config.test.ts`, `src/delegation/tool-inventory-audit.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts` |
| `terminal.run` excluded | Shell execution is not model-visible to default children. | `src/delegation/tool-inventory-audit.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Memory/session search unavailable | `session_search`, `memory.*`, and memory/search surfaces are unavailable to default children. | `src/delegation/tool-inventory-audit.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts`, `src/session/session-search-service.test.ts`, `src/session/session-recall-service.test.ts` |
| No skill/config/trust mutation | `skill.*`, `config.*`, cron, and workspace trust mutation surfaces are stripped by default. | `src/delegation/tool-inventory-audit.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts` |
| Hardline/fail-closed approvals | Hardline denies run first. Anything that would ask or rely on parent/persisted/session grants is denied in child runtimes. | `src/runtime/agent-loop-factory.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts` |
| Parent abort and `/stop` cleanup | Parent aborts and gateway `/stop` abort active child work and clean registry entries. | `src/delegation/child-runner.test.ts`, `src/delegation/delegation-manager.test.ts`, `src/channels/channel-gateway.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Gateway active-subagent queueing | With interrupt busy policy, ordinary messages queue while active subagents exist; control commands still bypass. | `src/channels/channel-gateway.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Heartbeat and timeout cleanup | Child heartbeat tracks activity; timeout aborts child work and removes active registry entries. | `src/delegation/child-runner.test.ts`, `src/delegation/progress-relay.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Batch timeout metadata | Batch aggregate may fail while per-child `timeout` / `cancelled` status is preserved. | `src/delegation/batch-runner.test.ts`, `src/delegation/delegation-manager.test.ts` |
| Diagnostics bounded/redacted/no full prompts | Diagnostics are profile-local, bounded, redacted, and omit prompt previews by default. | `src/delegation/child-runner.test.ts`, `src/delegation/delegation-mvp-security-audit.test.ts`, `src/smoke/cases/delegation-mvp.ts` |
| Child sessions excluded from recall/search/memory/prompt packing | Child transcripts are not pulled into parent context by default. | `src/runtime/agent-loop-factory.test.ts`, `src/session/session-search-service.test.ts`, `src/session/session-recall-service.test.ts` |
| Gateway active-turn stability | Active-subagent detection is runtime/session scoped and does not affect unrelated sessions. | `src/channels/channel-gateway.test.ts`, `src/gateway/active-turn-registry.test.ts` |

## Security Notes

Default child capability is intentionally narrower than Hermes terminal parity. Hermes can expose a broad terminal tool and rely on runtime approval callbacks. EstaCoda removes dangerous affordances from the child-visible schema by default: `terminal.run` and write/process/memory/session/config/trust mutation surfaces are absent before provider schemas are built.

`terminal.inspect` / `terminal.readonly` is the planned path for stricter shell-inspection parity. It should be implemented as a real read-only tool with deterministic command bounds, not by exposing `terminal.run` to children.
