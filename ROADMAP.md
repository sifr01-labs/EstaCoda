# Roadmap

## 1. Current State (v0.8)

### What works today

- CLI agent sessions with provider-backed tool execution.
- Hosted provider support: Kimi, OpenAI, DeepSeek, OpenRouter (runtime-proven).
- Capability-first security with `strict`/`adaptive`/`open` approval modes, hard safety floor, persistent approvals, and audit views.
- Interactive first-run onboarding in English and Arabic.
- Skill system: Markdown-first skills, official/personal/project/external sources, creation and mutation, usage telemetry, evolution proposals with review gates, and eval fixtures.
- Memory: bounded files (`SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`), session SQLite store, and promotion rules.
- Telegram gateway: allowlists, inline approvals, sessions, attachments, vision image analysis, generated image delivery, and voice transcription.
- MCP client: stdio and HTTP transports, config-driven registration, reload, and trust metadata.
- ACP server foundation: editor integration proven for chat, file reads, shell execution, and approvals.
- Browser automation via local Chrome DevTools Protocol.
- Cron jobs: persistent store, prompt scanning, script-backed execution, and tick locking.
- Voice/TTS/STT configuration foundation and audio artifact pipeline.
- Image generation: FAL and BytePlus/Seedream providers, aspect-ratio mapping, cache, and artifact recording.
- **Durable TaskFlow execution (v0.8):** multi-step flows with explicit state machine, operator controls (`/flow` slash and `estacoda flow` CLI), pause/resume/interrupt/cancel, step-level approval gates, `/steer` guidance, safe-boundary compaction, process ownership, restart recovery, and run/artifact linkage.
- Smoke test suite (`bun run smoke`).
- Eval fixture suite (`bun run scripts/run-eval.ts`) with 27 deterministic cases.

### What is unstable or incomplete

- Agent loop decomposition is complete (809 lines, down from ~2,700). Six components extracted and testable independently.
- Run recording persists to SQLite via `SQLiteSessionDB`. CLI inspection (`estacoda trace`) is available.
- The only automated safety net is a 14,000-line smoke file plus 27 eval fixtures. There are no focused unit tests.
- The runtime requires Bun (`bun:sqlite` prevents Node execution).
- Memory rendering is not ranked or freshness-aware.
- OpenRouter tool-call exactness is inconsistent.
- Local/Ollama support is present but unproven in practice.
- MCP HTTP transport is smoke-tested but not broadly live-proven.
- ACP editor integration lacks terminal/process rendering polish.
- Telegram is the only product-ready channel.
- Runtime CLI Arabic localization is incomplete beyond onboarding.
- Evaluation substrate runs automated fixtures with pass/fail scoring (`estacoda eval`). Focused benchmarks (golden flows, regression detection) exist but the corpus is small.
- Packaging, distribution, and update lifecycle are undecided.
- **TaskFlow v0.8 limitations:**
  - Checkpoints are recorded but not restorable.
  - Flows are scoped to a single session; no cross-session resumption.
  - Lock service is single-process SQLite only.
  - Auto-compaction is disabled by default.
  - No automatic retry without operator invocation.
  - No visual workflow builder or marketplace.

## 2. MVP Definition

MVP means EstaCoda can execute meaningful agentic work through a visible, recoverable, skill-aware, memory-aware, and policy-bounded runtime. It does not mean every feature is complete.

### Release readiness criteria

- Clean install flow and first-run onboarding.
- CLI and Telegram sessions execute skills and tools reliably.
- Runs are inspectable after completion.
- Memory can be viewed, edited, and deleted.
- Skill improvements are proposed with evidence and require review before promotion.
- Multi-step workflows can survive restarts and report status.
- Risky actions pass through approval policy.
- New capabilities surface permissions and risk before installation.
- Smoke tests and type checks pass.
- Security model and known limitations are documented.
- Contributor documentation exists.

## 3. Near-Term Roadmap (v0.4–v0.8)

### Runtime reliability (v0.4)

Agent execution phases can be tested independently. Tool planning has an explicit, inspectable representation. Cancellation and resume are supported. Artifact recording is cleaner and less coupled to the main execution path.

### Execution visibility (v0.5)

Every run produces a structured, persisted record. Tool calls are timestamped and tied to context. Failures are classified. Eval fixtures run against known scenarios. Runs can be inspected without reading raw chat transcripts.

### Skill system maturity and safety (v0.6)

Memory gains provenance, inspection, and deletion flows. Project and user memory are scoped separately. Memory rendering becomes selective rather than dump-based. Dependency graph output supports agent planning. Policy changes are treated as reviewable proposals, not invisible drift.

### Governed skill evolution (v0.7)

Self-improvement becomes evidence-backed and reviewable. The governed loop is: observe → propose → review → approve/reject → promote → rollback. Every proposal carries a `ChangeManifest` with hypothesis, predicted impact, risk level, eval plan, constraint gates, and rollback plan. High-risk or untrusted proposals require explicit approval. Promotion runs eval gates; failing gates block the promotion. No silent mutation. Tool-description and routing-metadata proposals are representable as manifest targets. A clean JSON export format (`OptimizationDataset`) is available for future DSPy/GEPA consumption.

### Durable TaskFlow execution (v0.8)

Multi-step agent work becomes durable and operator-controllable. Flows survive restarts. Steps have explicit lifecycle states with strict transition rules. Operator can pause, resume, interrupt, cancel, steer, approve, reject, retry, and skip. Process ownership ensures external processes are cleaned up on interrupt/cancel. Safe-boundary compaction preserves audit trails. Restart recovery runs automatically. CLI and slash command surfaces expose all operations.

**v0.8 completion notes:**
- Tracks 1–5 implemented and committed.
- Track 6 (docs, smokes, evals, hardening) is the final v0.8 pass.
- No new major runtime features added in Track 6.

## 4. Mid-Term Direction (v0.9+)

### Stronger autonomy

Skills improve from usage and failure evidence through governed proposals that include evidence and rollback instructions. Autonomy levels vary by risk domain: read and search operations act more freely; shell, deployment, and publication operations remain approval-gated.

### Better recovery

Checkpoint rollback. Cross-session flow resumption. Distributed lock considerations for multi-process deployments.

### Improved extensibility

Capabilities carry explicit manifests describing permissions and tool bindings. External skills are treated differently from bundled skills. Installation surfaces risk and required permissions. Basic eval hooks verify capability behavior before trust.

## 5. Non-Goals

The following are out of scope for the v0.4–v0.10 phase:

- Public marketplace or plugin store.
- Full GUI dashboard or visual workflow builder.
- Team/enterprise multi-user admin console.
- Feature parity with every Hermes or OpenClaw capability.
- Silent runtime self-modification or live self-evolution.
- Unbounded background autonomy without policy gates.
- Prompt-only optimization as the primary improvement strategy.
- Runtime code evolution without PR review.
- Channels beyond Telegram (Discord, email, calendar integration deferred).
- Background automation without explicit scheduling.

## 6. For Contributors

### Where contributions are useful

- Provider hardening and new provider routes.
- Channel adapters beyond Telegram.
- Skill eval fixtures and regression tests.
- MCP/ACP extensions and editor integrations.
- Documentation fixes and clarity improvements.
- Bug fixes in tools, channels, or CLI commands.

### What not to touch

- Agent loop structure (v0.4 decomposition is complete).
- Memory redesign (reserved for v0.6+).
- Security policy changes without prior discussion.
- Major refactors unrelated to the current roadmap milestone.

### Discipline

- Run `bun run typecheck` and `bun run smoke` before opening a PR.
- Do not refactor for style or introduce new dependencies without justification.
- Do not break the CLI or Telegram execution paths.
- Test under Bun. Node is not supported due to `bun:sqlite` usage.
