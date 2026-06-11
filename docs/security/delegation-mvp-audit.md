# Delegation Security Audit

Status: test-backed checklist for the v0.1.0 delegation/subagent implementation.

This audit covers shipped behavior only. MVP functional parity is implemented, and the branch also ships bounded outcome memory, stale-file warnings, same-provider and reviewed cross-provider child model overrides, active-subagent operator status, token usage rollup, and `terminal.inspect`. Parent-mediated child approvals and durable or estimated USD cost accounting are not shipped.

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
| Token usage rollup | Child provider usage is copied from structured provider execution metadata, preserved per child, and rolled up without prose scraping. Missing usage is explicit and non-fatal. | `src/delegation/delegation-manager.test.ts` |
| Outcome memory safety | Delegation outcome memory is opt-in, bounded, and records deterministic status/reason summaries rather than raw child output. | `src/delegation/delegation-manager.test.ts`, `src/memory/local-memory-provider.test.ts` |
| Stale parent file reads | Tracked parent reads are snapshotted before delegation; child writes to those paths produce advisory stale-file warnings using tracker sequence cursors. | `src/delegation/file-state-tracker.test.ts`, `src/delegation/file-state-guard.test.ts`, `src/delegation/delegation-manager.test.ts` |
| Child model overrides | Same-provider and reviewed cross-provider overrides preserve target provider config, avoid credential pools, reject disabled network routes, and disable fallbacks for overridden children. | `src/runtime/agent-loop-factory.test.ts`, `src/runtime/create-runtime.test.ts`, `src/gateway/supervisor.test.ts`, `src/acp/server.test.ts`, `src/tools/delegation-tools.test.ts` |
| Operator subagent status | Runtime/gateway status exposes bounded active-subagent summaries scoped to the parent session. | `src/delegation/subagent-registry.test.ts`, `src/runtime/create-runtime.test.ts`, `src/channels/channel-gateway.test.ts` |
| `terminal.inspect` read-only boundary | `terminal.inspect` is read-only-local, argv-only, bounded/redacted, rejects general shell behavior, and keeps `terminal.run` excluded from default child schemas. | `src/tools/terminal-inspect-tool.test.ts`, `src/delegation/tool-inventory-audit.test.ts`, `src/delegation/toolset-security.test.ts`, `src/runtime/create-runtime.test.ts` |

## Security Notes

Default child capability is intentionally narrower than a broad terminal model. EstaCoda removes dangerous affordances from the child-visible schema by default: `terminal.run` and write/process/memory/session/config/trust mutation surfaces are absent before provider schemas are built. `terminal.inspect` is the reviewed read-only terminal surface; it allows only a narrow inspection command set and does not provide shell execution.

Delegation capability parity is shipped except for durable or estimated USD cost accounting and parent-mediated child approvals. Token usage rollup is shipped. Child approvals remain non-interactive fail-closed; adding parent-mediated approval would require a separate design and security review.
