---
title: "Prelaunch Milestones"
description: "What landed in v0.4 through v0.7, known gaps, and baseline before v0.8."
---

# Prelaunch Milestones

## v0.4 — Agent-Loop Decomposition

**Goal:** Turn opaque agent behavior into inspectable execution.

**Landed:**
- Provider turn-loop extraction (`ProviderTurnLoop`)
- Native intent executor extraction (`NativeToolExecutor`)
- Tool-plan dependency model (`ToolPlanRunner`)
- Cancellation/resume substrate
- Artifact recorder cleanup
- Run/trajectory structure
- Clearer boundaries between router, planner, executor, recorder
- Agent loop reduced from ~2,700 lines to ~800 lines

**Status:** Complete.

## v0.5 — Trace, Eval, and Evidence Substrate

**Goal:** Make every run observable, replayable, and falsifiable.

**Landed:**
- Structured trajectory recorder with 32 event kinds
- Trace schema and tool-call timeline
- Decision/event log
- Run metadata and failure classification (13 classes)
- Basic eval runner with deterministic fixtures
- Regression fixtures
- Run replay skeleton
- Prompt/tool/result capture with safe redaction
- Evidence corpus structure
- `estacoda trace` CLI commands

**Status:** Complete.

## v0.6 — Memory, Dependency Graph, and Knowledge Graph

**Goal:** Make learning useful without poisoning context.

**Landed:**
- Memory store with provenance and inspection
- Memory promotion rules
- Selective memory renderer (not dump-based)
- Project knowledge graph
- Code dependency graph integration
- Session search
- Memory provenance and trace links
- Safety file protection (`SOUL.md`, `AGENTS.md` cannot be deactivated)
- Smoke harness deduplication (monolithic 14k-line smoke split)

**Status:** Complete.

## v0.7 — Governed Skill Evolution, Curator, and Evidence-Backed Self-Improvement

**Goal:** Turn repeated behavior and failure evidence into durable, governed capability.

**Landed:**
- Governed loop: observe → propose → review → approve/reject → promote → rollback
- `ChangeManifest` with hypothesis, predicted impact, risk level, eval plan, rollback plan
- Skill proposal service (`SkillProposalService`)
- Curator status CLI (`estacoda curator status`)
- Proposal CLI (`estacoda proposal list/inspect/approve/reject/promote`)
- Manifest CLI (`estacoda manifest list/inspect`)
- User correction capture as structured trajectory events
- Tool-description proposal skeletons
- Routing-metadata proposal skeletons
- DSPy/GEPA-compatible `OptimizationDataset` export format
- 18 deterministic eval fixtures
- AHE alignment documentation

**Deferred:**
- `estacoda skill` namespace CLI (`list`, `inspect`, `usage`)
- In-session slash commands for skill review
- Auto-proposal generation from observations (threshold-based pipeline)
- Full DSPy/GEPA pipeline integration
- Tool-description and routing-metadata auto-application

**Status:** Complete.

## Historical Gaps Before v0.8

1. **No unit tests** — Resolved later by the authoritative Node/Vitest test lane.
2. **Bun lock-in** — Resolved later by the Node/pnpm migration and `better-sqlite3` adapter.
3. **Artifact persistence** — `ArtifactStore` is still thin.
4. **Auto-proposal pipeline** — Threshold-based generation not built.
5. **Memory policy evolution** — Excluded from v0.7.
6. **Runtime code evolution** — Explicitly out of scope until post-MVP.

## Next: v0.8 — Durable TaskFlow

**Goal:** Make long-running agent work resumable, cancellable, and auditable.

**Planned:**
- Flow state machine
- Step states and wait/resume/cancel
- Child tasks
- Flow persistence across restarts
- Human approval gates
- Retry policy and failure states
- Flow replay after restart
- Artifact linkage
- Flow-to-run recorder integration

---

*This file replaces the individual execution plans for v0.4–v0.7. For detailed execution plans, see the private workspace.*
