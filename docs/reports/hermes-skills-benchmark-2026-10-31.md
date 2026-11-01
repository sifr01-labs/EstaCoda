# Hermes Agent versus EstaCoda: skills benchmark
Date: 31 October 2026

## Verdict

Hermes currently has the more effective agent-facing skill discovery and active maintenance design. EstaCoda already has substantial routing, retrieval, capability recovery, and governed evolution infrastructure; its main opportunity is to make that infrastructure more legible and useful to the model.

The highest-value change is a complete, descriptive skill index. Next are evidence-backed improvement drafts, explicit refresh handling, and consistent read/use/outcome telemetry. Copy Hermes's usability patterns selectively; preserve EstaCoda's authority, approval, profile, and installation boundaries.

This is a source-level architecture comparison plus executed deterministic probes, not a live-model task-success, latency, cost, or security-certification benchmark.

## Versions and method

- Hermes: latest default-branch commit returned by GitHub when this research began, [adecc4024456b387b1518813b90bd60c82b51287](https://github.com/NousResearch/hermes-agent/commit/adecc4024456b387b1518813b90bd60c82b51287), committed 31 October 2026 at 06:03:57 UTC. All Hermes file reads were pinned to that SHA.
- EstaCoda: local working tree based on `053903e0903918be971a30701d8070f2187af03f`, dated 30 October 2026. The checkout contains local edits, including changes appearing during this investigation. Findings describe the inspected working tree, not a clean release or exclusively that commit.
- Read runtime code, prompt assembly, loaders, management tools, evolution paths, and relevant tests. Did not rely on marketing or assume subsystem docs were current.
- Loaded the 22 bundled EstaCoda skills through its actual loader, registry, and prompt assembly. This is a neutral bundled-catalog probe, not the user's active profile or a session after availability filtering.
- Ran the pinned Hermes index-rendering function and description clipper extracted through Python AST, with controlled interactive-session context. Fed both designs the same catalog. No other Hermes runtime code, dependencies, network tasks, or agents were executed.
- Added a synthetic 12-skill category to exercise scaling. Probed EstaCoda's existing capability discovery for a name omitted from its initial index.
- Results are preserved in [the measurement file](hermes-skills-benchmark-2026-10-31.json).

## What Hermes actually does

### Discovery and exposure

Skills use YAML-frontmatter `SKILL.md` files with optional references, templates, scripts, and assets. Discovery resolves project, profile-local, configured creation-directory, and external roots in that precedence order; plugin skills also enter the prompt under qualified names. Project roots need explicit skill trust and pass through quarantine scanning. This is not unrestricted workspace auto-loading. [Root resolution and project trust](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/skill_utils.py#L401-L661)

The normal system prompt shows a grouped index of skill names and descriptions. Descriptions are clipped to 60 characters at word boundaries. Focused categories can collapse to names-only rows, but the renderer does not discard the eligible skill names. Prompt text strongly encourages loading relevant skills and updating incomplete instructions after difficult work. The single-query path has distinct guidance. [Index renderer](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/prompt_builder.py#L1295-L1358), [description budget](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/skill_utils.py#L842-L866)

The central model-facing interaction is:
1. Notice a skill in the prompt, or call `skills_list`.
2. Call `skill_view` for its root instructions.
3. Read an individual linked resource only when needed.
4. Use ordinary execution tools to perform the task.
5. Use `skill_manage` to persist improvements when appropriate.

Loading also returns readiness and setup information. Successful reads count as views and uses; unchanged repeated reads can return a compact stub. Loading is not necessarily a pure read: the inspected path can invoke `pm.ensure` for declared dependencies. Inline-shell preprocessing is separately configurable and defaults off. [View and usage path](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/tools/skills_tool.py#L613-L786), [preprocessing](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/skill_preprocessing.py#L142-L156)

### Updates and learning

`skill_manage` exposes create, patch, support-file write/removal, and delete operations through one management interface. Its current schema supports a batch of operations with snapshots, locks, and rollback on failure. Background review must read the target before changing it. Successful mutations attempt to record before/after history in a ledger and invalidate skill prompt caches. Ledger recording is best-effort rather than a mandatory commit gate. [Management implementation](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/tools/skill_manager_tool.py#L672-L853), [batch rollback](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/tools/skill_manager_batch.py#L219-L286), [read-before-write guard](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/tools/skill_manager_guards.py#L211-L221)

Hermes has a configurable write-approval mechanism. With `skills.write_approval` on, writes are staged for review; with it unset or invalid, that gate is off. The manager's gate-import failure also allows execution to continue. Scanning agent-created skills is a separate opt-in. Therefore Hermes is neither “no governance” nor “mandatory approval by default.” [Approval defaults and gate](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/tools/write_approval.py#L37-L64), [staging behavior](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/tools/write_approval.py#L190-L215), [manager defaults](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/tools/skill_manager_tool.py#L41-L64)

A tool-iteration threshold can trigger skill review after the foreground answer is delivered. The review fork's dispatch whitelist normally permits skill tools and read-only file tools, with explicit configured additions possible. This is a real background maintenance path, not merely a slogan about learning after every task. Reviews are enabled by default in the settings helper, with exceptions including safe-worker and finite-turn contexts. [Turn-end trigger](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/turn_finalizer.py#L831-L860), [review settings and tool restrictions](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/background_review.py#L228-L250), [review whitelist](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/background_review.py#L1092-L1132)

The curator separately supports inactivity-driven lifecycle maintenance. Defaults are weekly eligibility, two hours idle, stale after 14 days, and archive after 30 days. LLM consolidation is opt-in. Pinned skills and curator-ownership rules constrain maintenance; archival is recoverable. These are configured thresholds, not a guarantee of a scheduled run at an exact time. [Curator implementation](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/curator.py#L1-L35)

Newly added or removed skill names can reach an existing conversation through a per-turn delta note while keeping the cached system prefix stable. This mechanism compares catalog membership; it does not by itself announce every same-name content edit. MoA and `codex_app_server` paths are explicitly excluded. [Delta implementation](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/skills_index_delta.py#L102-L137), [runtime call site](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/agent/turn_context.py#L1195)

Bundled updates use origin hashes: update pristine copies, retain user modifications. [Sync decision](https://github.com/NousResearch/hermes-agent/blob/adecc4024456b387b1518813b90bd60c82b51287/tools/skills_sync.py#L356-L378)

## Comparison with EstaCoda today

| Dimension | Hermes | EstaCoda | Assessment |
|---|---|---|---|
| Initial skill visibility | Names plus short descriptions; names retained when compacted | Names plus required toolsets; first eight entries per category | Hermes gives the model better selection cues and scaling behavior. |
| Recovery when initial choice misses | Model can list/view another skill | `skill.list`, `capability.discover`, `capability.request`, then `skill.read` | EstaCoda already has recovery; avoid building a duplicate search system. |
| Selection | Model follows catalog guidance; explicit/preloaded skill paths also exist | Standard deterministic routing plus optional live Jev-assisted routing; explicit multi-skill requirements | Different tradeoffs; source inspection cannot establish routing-accuracy superiority. |
| Root/resource loading | Full root on view; linked files on demand; repeated-read dedup | Up to 8,000 root characters inline; larger roots become bounded contracts; explicit full read and named-skill search | EstaCoda has a useful large-document retrieval design. |
| Newly installed/created skills | Membership delta notes on supported turn paths | Session skill registry/catalog is captured at construction | Hermes has a smoother freshness mechanism. EstaCoda's recovery expands exposure within the captured registry. |
| Skill creation and repair | Unified management tool; background review can write according to configured gate | Direct mutation tools plus separate observations, proposals, review, approval, promotion, rollback | EstaCoda is not missing editing; the learning-to-reviewed-change workflow is less automatic. |
| Autonomous learning policy | Active review and curator behavior with configurable write gate | `autonomous` still forces auto-promotion and auto-rollback off | Intentional EstaCoda policy boundary; do not remove it to match Hermes. |
| Provenance and ownership | Local copies, external roots, project trust/quarantine, ledger | Profile-owned state; local > bundled > external precedence; working copies shadow nonlocal skills | Preserve EstaCoda's source ownership model. |
| Upstream bundled updates | Hash-based preservation of customized copies | Hash-based preservation of customized copies and reset/rebaseline | Broad capability parity. |
| Read/use evidence | View path bumps view/use telemetry | Canonical `skill.read` records recovery receipts but deliberately does not bump legacy viewed telemetry; route/outcome recording exists separately | EstaCoda needs clearer, consistent evidence semantics. |
| Improvement validation | Schema/size checks, optional scan, guards, batch rollback | Proposal trust/risk gates, snapshots, metadata/playbook evals | Neither inspected path demonstrates a general real-task quality gate for every proposed skill revision. |
| Portability | YAML/Agent Skills conventions, plugins, trusted project roots | JSON-frontmatter contract with richer runtime declarations; configured external roots and packs | Hermes has easier ecosystem reuse; adaptation must preserve EstaCoda's contract. |

EstaCoda implementation references:
- [Prompt index](../../src/prompt/prompt-assembly.ts), `renderSkillsIndex` at line 1954.
- [Session construction and visibility](../../src/runtime/agent-loop-builder.ts), lines 519–534 and 848 onward.
- [Capability discovery/recovery](../../src/tools/capability-tools.ts), lines 103–166 and the tool schemas near line 330; [core tool selection](../../src/runtime/tool-selection-policies.ts).
- [Routing and supporting instructions](../../src/runtime/runtime-router.ts), lines 86–167; [live Jev selection](../../src/runtime/jev/live-routing.ts).
- [Large-skill contracts](../../src/skills/skill-contract.ts), [limits](../../src/skills/skill-limits.ts).
- [Skill management and read telemetry](../../src/tools/skill-tools.ts), [learning observations](../../src/skills/skill-learning.ts).
- [Evolution policy](../../src/contracts/agent-evolution.ts), [proposal promotion and evaluation](../../src/skills/skill-proposal-service.ts).
- [Mutation authority checks](../../src/skills/skill-mutation-policy.ts), [bundled sync](../../src/skills/skill-bundled-sync.ts).

Do not interpret “governed evolution” as proof that every write goes through a proposal. EstaCoda exposes direct `skill.create`, `skill.patch`, and related mutation tools as well. Their execution policy, ownership checks, and validation are separate from the proposal lifecycle. Likewise, promotion evaluations currently check declared metadata/playbook properties; no evaluation cases returns `not-run`, and the promotion path blocks `failed`, not every `not-run` result.

## Executed benchmark

Same input catalog, different index implementations:

| Probe | EstaCoda | Hermes normal | Hermes all-categories compact |
|---|---:|---:|---:|
| Real bundled catalog: names shown | 22/22 | 22/22 | 22/22 |
| Real catalog: descriptions shown | 0/22 | 22/22, clipped | 0/22 |
| Real catalog: index characters | 792 | 1,731 | 635 |
| Synthetic one-category catalog: names shown | 8/12 | 12/12 | 12/12 |
| Synthetic index characters | 189 | 937 | 166 |

Character counts cover the rendered index segment, not the entire prompt or tool schemas. EstaCoda's count includes its short index heading; Hermes's excludes the surrounding XML tags and instruction prose. Hermes's full skill block for the real-catalog normal case was 2,905 characters. The formats also carry different metadata: EstaCoda includes toolsets. These are context-footprint measurements, not token-cost or latency measurements.

Interpretation:
- The eight-per-category limit is a demonstrated scaling gap, but it does not currently hide any of the 22 bundled skills: the largest bundled category has four.
- The synthetic omitted `fixture-12` was successfully returned by EstaCoda's real `capability.discover` handler. It is omitted from the initial index, not inaccessible.
- Hermes's normal index spends 939 more characters on this input to provide short descriptions for all 22 skills.
- Compressing to names-only need not drop entries. Hermes's all-categories compact case illustrates a formatting option, not its universal default.
- Seven EstaCoda bundled roots exceed its inline threshold. Their root sizes span 9,902–18,101 characters; their generated contract content spans 1,555–2,778 characters. This is a real capability worth retaining.
- EstaCoda's `skill.list` returned all 22 catalog entries with descriptions. The information exists; the initial prompt does not use it.

## Recommended priorities

1. **Improve the existing index first.** Add concise invocation descriptions, retain every eligible skill ID, and use explicit compact fallback/overflow guidance instead of silent `slice(0, 8)`. Preserve session visibility and authority gates. Do not copy Hermes's blanket instruction to load even partially relevant skills without measuring unnecessary reads.

2. **Connect evidence to concrete review drafts.** EstaCoda's learning manager records observations and candidates. Turn well-supported candidates into a small patch with evidence, changed behavior, validation, and rollback metadata through the existing proposal service. Keep explicit promotion and current autonomous-mode constraints.

3. **Make catalog freshness explicit.** Add an operator-controlled refresh or reviewed membership delta mechanism that revalidates visibility, identity, profile scope, and capability state. Hermes demonstrates that membership updates need not rewrite the cached system prompt. Do not silently replace live instructions mid-turn.

4. **Unify learning telemetry.** Distinguish catalog exposure, root read, resource read, actual execution, outcome, and improvement adoption. Canonical `skill.read` should not disappear from learning evidence simply because the deprecated alias owns a legacy counter; avoid treating a read as proof of task success.

5. **Add outcome-based promotion checks where useful.** Run representative bounded fixtures for changed skills and compare against the previous revision. Existing metadata gates are valuable but cannot prove improved task completion.

6. **Consider compatibility later.** A deliberate YAML-to-EstaCoda import/translation path or separately trusted project-skill root could improve reuse. Neither is needed to fix prompt visibility, and both deserve a distinct trust and ownership review.

Also correct the subsystem documentation: it still says semantic/LLM signals are only shadow authority and supporting skills are only advisory, while the current router contains live Jev selection and explicit supporting-skill prompt delivery. It also understates discovery now provided by `capability.discover`. These are documentation findings, not changes made by this research.

## Validation and limits

Executed:
- Node `v24.14.1`; pnpm `10.33.0`.
- Actual EstaCoda loader/registry/prompt/read-list/discovery probes and extracted Hermes renderer/description-clipper probes.
- Ten focused test files: **257 passed** (loader, contract, registry, skill tools, learning, proposal service, intent router, runtime router, prompt assembly, evolution policy).
- Three additional focused files: **97 passed** (capability tools, agent-loop builder, live Jev routing).
- Total: **354 tests across 13 files passed**.

The Hermes full test suite was not run. No provider-backed comparative tasks, live skill mutation, package installation, or curator runs were performed. The full EstaCoda install/typecheck/test/smoke/build/audit validation sequence was not run because runtime implementation was not changed. This report does not claim whole-repository validation or a comprehensive security audit.

These measurements are the pre-change research baseline. Subsequent implementation and its limits are described in [Skills](../subsystems/skills.md); the measurements above are not post-implementation performance claims.
