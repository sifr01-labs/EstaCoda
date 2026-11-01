---
title: "Skills"
description: "Skill system: loading, registry, execution, evolution, and learning."
---

# Skills

The skill system is the most mature subsystem in EstaCoda. It provides procedural knowledge to the agent through Markdown-first documents that are progressively disclosed.

## Files

| File | Role |
|------|------|
| `src/skills/skill-loader.ts` | Load and validate skill directories |
| `src/skills/skill-registry.ts` | Hold loaded skills, resolve source conflicts, and expose catalogs |
| `src/skills/skill-contract.ts` | Build deterministic prompt contracts for oversized selected skills |
| `src/skills/skill-readiness.ts` | Resolve setup/readiness metadata shared by routing and skill tools |
| `src/tools/skill-tools.ts` | Agent-facing `skill.*` tools for inspection, mutation, proposals, eval gates, rollback, import, and export |
| `src/skills/skill-evolution.ts` | Store observations, candidates, proposals, experiments, evals, promotions, snapshots, and rollback metadata |
| `src/skills/skill-learning.ts` | Observe completed turns and emit evidence/candidates; not mutation authority |
| `src/skills/skill-proposal-service.ts` | Convert candidates into governed proposals and run promotion gates |
| `src/skills/change-manifest-store.ts` | Persist JSONL change manifests linked from proposals |
| `src/skills/skill-playbook-planner.ts` | Compile skill playbook plans |
| `src/skills/skill-usage-telemetry.ts` | Usage tracking and route telemetry |
| `src/skills/skill-bundled-sync.ts` | Bundled-skill sync helper |
| `src/skills/skill-visibility.ts` | Runtime visibility filtering |
| `src/skills/skill-mutation-policy.ts` | Trust and mutation checks |
| `src/skills/skill-curator-status.ts` | Curator status and proposal listing |

## Skill Sources

| Source | Directory | Mutability | Load order |
|--------|-----------|------------|------------|
| `external` packs | `~/.estacoda/profiles/<profile-id>/skills/packs/` | Managed/materialized by pack flows | Loaded first, lowest priority |
| `bundled` | `skills/official/` in the package/repo | Read-only package content | Loaded after packs |
| `local` | `~/.estacoda/profiles/<profile-id>/skills/` | Profile-local mutable skills | Loaded after bundled skills and can shadow lower-priority sources |
| `external` configured roots | `skills.externalDirs` / runtime `externalSkillRoots` | Operator-controlled external roots | Loaded from configured directories |

The runtime does not currently load `<workspace>/.estacoda/skills/` as a project-skill root. Workspace context is loaded separately from project context files.

## Execution Model

**Provider-backed:** In normal provider-backed turns, selected skill instructions and resources are exposed through prompt/context assembly. The provider still chooses output and tool calls; deterministic safety gates remain outside the skill text.

**Playbook planning:** `src/skills/skill-playbook-planner.ts` compiles declared playbook steps for deterministic planning and inspection surfaces.

**Resources:** `references/`, `templates/`, `scripts/`, and compatible `assets/` are indexed and loaded on demand by the skill loader.

## Indexed Loading and Retrieval

Selected skills are loaded through an indexed prompt model:

- The session-visible index retains every eligible name with an 80-character description. Above a 6,000-character description budget it explicitly switches to names and toolsets, retaining every name. Visibility still comes from profile, lifecycle, platform, and capability gates.
- `/skills refresh` rebuilds the runtime between turns, rechecks session/profile identity and normal visibility/readiness gates, and reports added, removed, and changed visible skills. Changes to instructions under the same name are detected. A scoped session notice tells the agent to reload changed skills before relying on earlier reads. The new index applies on the next turn; there is no mid-turn mutation of cached system context.
- Skills at or below the root inline cap are injected into the prompt with their full root `SKILL.md` instructions.
- Oversized selected skills are represented in the prompt as deterministic contracts instead of silently truncated root bodies.
- Contract prompt content includes the skill name, description, original root character count, heading index, linked resource/script index, and an explicit note that referenced resource contents are not included.
- Full oversized root content can be recovered on demand with:

```ts
skill.read({ "name": "<skill>", "mode": "full" })
```

Reference, template, script, and asset files are lazy. Their paths are indexed, but their contents are not injected into prompts or contracts by default.

`skill.read` is the canonical model-visible read/retrieval tool:

- `skill.read({ "name": "<skill>" })` returns full root instructions for small loaded skills and contract content for oversized loaded skills.
- `skill.read({ "name": "<skill>", "mode": "full" })` returns the loaded root body capped by the read limit, with metadata such as `originalChars` and `truncated`.
- `skill.read({ "name": "<skill>", "path": "references/example.md" })` reads one skill-local resource through path containment and size checks.
- Read metadata preserves the skill metadata payload and adds linked files plus setup/readiness fields.

`skill.view` remains registered as a deprecated compatibility alias for `skill.read`. New prompt copy, docs, and tools should prefer `skill.read`.

`skill.search` is a named-skill-only retrieval tool:

- `skill.search({ "name": "<skill>", "query": "<text>", "maxResults": 5 })` searches only that named skill's loaded `SKILL.md` root instructions and indexed resources.
- It returns bounded deterministic excerpts with paths, match counts, optional line/heading context, and truncation metadata.
- It does not perform global skill search, nearby skill routing, candidate discovery, usage telemetry, or Agent Evolution/AHE evidence collection.

Successful `skill.read` and deprecated `skill.view` calls share viewed telemetry, with separate root/resource read counts. Failed reads do not count. Reads do not increment selected-use or task-success counters. Routing selections and task outcomes retain their separate meanings in the same profile-local usage store.

## Python Capabilities

A skill can declare that it needs a runtime-registered Python capability:

```yaml
pythonCapabilities:
  - id: example-capability
    required: true
    groups: []
```

For example, a future registered capability could expose an optional group:

```yaml
pythonCapabilities:
  - id: ocr-and-documents
    required: true
    groups: []
  - id: ocr-and-documents
    required: false
    groups: ["advancedOcr"]
```

The skill declaration is not a package manifest. Each entry may contain only `id`, `required`, and `groups`.

The runtime registry owns package names, package versions, import checks, install paths, and optional group definitions. Unknown capability IDs, unknown groups, and unknown metadata keys fail validation according to the skill loader rules.

Normal skill execution resolves only already-installed and verified environments. It does not run `pip`, create virtualenvs, or repair missing dependencies.

Missing required capabilities do not silently remove the skill from the loaded session catalog. The skill keeps setup/readiness metadata so prompt assembly, routing, and `skill.read` can explain the blocker and show the local repair command. Gateway surfaces can convert that setup state into an explicit managed Python capability setup approval when the selected skill needs it.

## Visibility

- Visibility is **session-stable**. Once a session starts, the visible skill catalog does not change.
- Filtered by runtime conditions (provider capability, trust level, etc.).
- Refreshed on `/new` or new session. `/reset` remains a deprecated alias.

## Operations

The agent-facing surface is the `skill` toolset implemented in `src/tools/skill-tools.ts`. Current tool names include:

| Area | Tools |
|------|-------|
| Read/retrieve/inspect | `skill.list`, `skill.read`, `skill.search`, `skill.view` (deprecated alias), `skill.inspect`, `skill.eval`, `skill.usage` |
| Learning and proposals | `skill.observe`, `skill.propose_patch`, `skill.list_proposals`, `skill.review_proposals`, `skill.review_proposal`, `skill.approve_patch`, `skill.reject_patch`, `skill.promote_patch` |
| Mutation | `skill.create`, `skill.patch`, `skill.edit`, `skill.delete`, `skill.rollback`, `skill.reset`, `skill.write_file`, `skill.remove_file` |
| Portability | `skill.import`, `skill.export` |

## Evolution

Skill evolution is **governed, not autonomous mutation**. Agent Evolution is the user-facing control plane for reviewable self-improvement: policy, route/outcome telemetry, evidence, learning candidates, governed proposals, experiment records, and review listings.

**Governed loop:**

```
observe → evidence/candidate → proposal → eval/review → manual promotion → rollback if needed
```

**Current capabilities:**

| Capability | Status |
|------------|--------|
| Usage telemetry (`skill-usage-telemetry.ts`) | `smoke-tested` |
| Agent Evolution policy derived from persisted `skills.autonomy` | `tested` |
| Route/outcome telemetry fields for routing evidence and future advisory signals | `tested` |
| SkillLearningManager observes completed turns and emits evidence/candidates | `tested` |
| Governed proposal kinds: `skill_patch`, `skill_create`, `routing_metadata_update` | `tested` |
| EvolutionExperiment records for evidence/proposal/metric grouping | `tested` |
| `estacoda proposal list` review queue and `inspect` detail view | `tested` |
| Observe with `candidateImprovement` → create ChangeManifest | `smoke-tested` |
| Propose patches (`skill-evolution.ts`) | `smoke-tested` |
| Review proposals with trust/risk scoring | `smoke-tested` |
| Approve/reject/promote via agent tools and CLI | `smoke-tested` |
| Eval-gated promotion (failing eval blocks promotion) | `smoke-tested` |
| Promotion gates (untrusted-source blocking) | `smoke-tested` |
| Eval deltas in promotion records | `smoke-tested` |
| Rollback tool (`skill.rollback`) | `smoke-tested` |
| ChangeManifestStore wired into runtime (no longer orphaned) | `smoke-tested` |
| Tool-description proposal skeleton (`target: "tool_description"`) | `smoke-tested` |
| Routing-metadata proposal skeleton (`target: "routing_metadata"`) | `smoke-tested` |
| Governed route contract with task class, primary/supporting/candidate/rejected/deferred candidates | `tested` |
| Local semantic route shadow telemetry | `tested` |
| Bounded LLM route reranker shadow telemetry | `tested` |
| Semantic routing readiness evals | `tested` |
| DSPy/GEPA-compatible export (`estacoda evolution export`) | `smoke-tested` |

**What "governed" means:**

- `SkillLearningManager` is an evidence source. It does not directly create, patch, promote, or mutate skills as final authority.
- In proactive/autonomous mode, repeated failed uses of the same selected skill and task across at least two sessions can prepare an executable instruction patch through `SkillProposalService`. The bounded, tool-free drafter uses the configured main model and shared provider spend/usage accounting. It receives existing skill text and compact outcome/tool-name evidence, not raw user messages or tool arguments/results. It may abstain when the evidence cannot support a specific correction.
- Draft attempts are limited to once per learning record per day and three records per runtime learning store per day (or a lower configured proposal budget), with at most one pending proposal per skill. Requests have a 20-second ceiling, 1,500 output tokens, no fallback, cancellation, and any configured evolution cost ceiling. Existing profile/session/task provider-spending gates still apply. Independent concurrent runtimes do not share an atomic draft-attempt quota.
- Generated learning patches require explicit approval, matching source-content hashes, and paired task evidence before promotion. They preserve the existing authority-expansion checks and use profile-local working copies. Successful promotion replaces the in-memory definition for that same owned file; existing session exposure changes still require refresh.
- `SkillEvolutionStore` owns observations, learning candidates, proposals, eval/promotion/snapshot/rollback metadata, experiment records, and experiment links.
- `ChangeManifestStore` owns change manifests. Evolution records may link to manifests, but manifests are not stored in `SkillEvolutionStore`.
- Proposed manifest-backed changes carry a `ChangeManifest` with hypothesis, predicted impact, risk level, eval plan, constraint gates, and rollback plan.
- High-risk or untrusted proposals require explicit approval before promotion.
- Promotion runs eval gates; failing gates block the promotion.
- No silent mutation — every change is logged, reviewable, and reversible.
- Bundled and external skill assets are not mutated. Bundled skills can be shadowed only by local/profile-owned working copies.
- Autonomous mode is shadow-only: it records policy decisions and proposal metadata, but it does not auto-promote, auto-rollback, or bypass gates.
- Routing remains deterministic as the official selector. The route contract records task class, one primary skill, supporting candidates, lower-confidence candidates, rejected candidates, deferred candidates, local semantic shadow telemetry, and bounded LLM reranker shadow telemetry as evidence for Agent Evolution.
- Supporting skills are advisory telemetry only. Only the primary selected skill contributes prompt instructions, toolset hints, setup context, and confirmation hints.
- Local semantic shadow routing and LLM reranking are non-authoritative. They cannot select unknown skills, override negative/defer rules, authorize tools, mutate skills, or promote anything.

**Limitations:**

- `skill.eval` remains a metadata/playbook check and labels its result accordingly. It refuses to report unexecuted final-state or degraded-behavior assertions as passing. It does not run real tasks.
- Learned executable drafts additionally require operator-attested paired task results. The operator runs and independently grades representative baseline/candidate tasks, then imports the report. Import validates the report and exact skill hashes; it does not execute tasks, inspect the referenced artifacts, or prove that operator-supplied grades are truthful. Legacy/manual proposals retain their existing metadata gates and do not thereby establish a performance improvement.
- Automatic drafting currently handles selected-skill instruction refinements after repeated failures. New-skill creation, routing changes, consolidation, and successful-task candidates remain reviewable candidates/proposal records; they are not automatically synthesized into executable changes.
- Tool-description and routing-metadata proposals are representable as manifest targets but not auto-applied.
- No autonomous promotion or rollback automation.
- No provider embeddings.
- No semantic or LLM route signal is official routing authority yet.
- No advisory route tools such as `skill.reject_route` and `skill.search_routes`.
- No skill fork/merge/archive governed proposal operations.
- No hygiene scanning loop for automatic proposal creation.
- The primary shipped CLI surfaces are `estacoda skills`, `estacoda proposal`, `estacoda manifest`, `estacoda curator`, and `estacoda evolution`. Do not document a separate `estacoda skill` namespace unless the command registry exposes it.

**CLI surface:**

```bash
estacoda proposal list [--skill <name>] [--status <s>]
estacoda proposal inspect <id>
estacoda proposal evaluate <id> <paired-task-report.json>
estacoda proposal approve <id>
estacoda proposal reject <id>
estacoda proposal promote <id>
estacoda manifest list [--target <t>] [--status <s>]
estacoda manifest inspect <id>
estacoda curator status
estacoda evolution export --dataset <path> [--since <date>] [--skill <name>]
```

## Agent Evolution

Agent Evolution is the user-facing control plane for EstaCoda's reviewable self-improvement behavior. The persisted compatibility key remains `skills.autonomy`; setup and settings present it as Agent Evolution.

| Mode | Behavior |
|------|----------|
| `none` | No Agent Evolution evidence or proposals |
| `suggest` | Records evidence/candidates and creates reviewable proposal records; no promotion |
| `proactive` | Can prepare bounded instruction drafts after repeated failures; task evidence and approval gate promotion |
| `autonomous` | Same bounded drafting plus shadow decisions; no real auto-promotion or auto-rollback |

Roadmap behavior must remain labeled as planned until implemented: provider embeddings, semantic/LLM routing as official authority, advisory route tools, real autonomous promotion, auto-rollback, skill fork/merge/archive, and hygiene scanning.

### Paired task evidence

Run the unchanged and proposed skill against the same representative task fixtures, model settings, environment, and independent grader. Use the benchmark runner or an external task harness in operator-controlled isolated workspaces. Include a targeted repair case and a regression case; do not use the drafting model's self-assessment as the grader. This command records an operator attestation, so it is deliberately absent from the model-visible skill tools:

```bash
estacoda proposal evaluate <id> paired-task-report.json
estacoda proposal inspect <id>
estacoda proposal approve <id>
estacoda proposal promote <id>
```

The report is version 1 with `baselineHash` and `candidateHash` (SHA-256 of the exact full `SKILL.md` bytes), `suiteId`, `modelId` (including fixed settings), `environmentHash`, `graderId`, and `cases`. Each of 2–100 cases has a unique `id`, a `fixtureHash`, and `baseline`/`candidate` objects containing a score from 0 to 1, `safetyPassed`, and a distinct run `artifact` reference. Candidate scores must be at least 0.8, no case may regress, every candidate safety check must pass, and at least one task score must improve. Keep private task contents and credentials out of the report. Import resets approval so the operator reviews the new evidence. A changed source invalidates the draft/evaluation rather than applying it to a different version.

Security note: automatic drafting adds a bounded provider request in modes that permit patch preparation. Draft text is untrusted until review; neither a model suggestion nor an operator-attested score grants tool authority. No skill, resource, credential requirement, or permission is automatically activated by learning.

## Contracts

Key types in `src/contracts/skill.ts`:

- `SkillDefinition`
- `LoadedSkill`
- `SkillCatalogEntry`
- `CompiledSkillPlaybook`
- `CompiledSkillPlaybookStep`
- `SkillOutcome`
