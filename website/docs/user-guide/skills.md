---
title: Skills
description: Skill system, official catalog, and skill boundaries for v0.1.0.
sidebar_position: 6
---

# Skills

Skills are procedural knowledge documents that EstaCoda loads into the prompt context. They tell the agent how to perform specific tasks. Skills are Markdown-first, progressively disclosed, and session-stable.

This page explains where skills come from, how they are structured, and what the system can and cannot do with them.

---

## What Skills Are

A skill is a directory containing a `SKILL.md` file and optional resources (`references/`, `templates/`, `scripts/`). The `SKILL.md` file defines the skill's purpose, instructions, and execution behavior.

Skills are not plugins. They do not execute code outside the agent loop. They are instructions and resources that the agent reads and follows.

---

## Skill Sources

Skills load from three sources in this priority order:

1. **Profile-local skills** — `~/.estacoda/profiles/<id>/skills/`. Mutable. Created by the operator or learned from workflows.
2. **Bundled official skills** — shipped in the repo under the skills directory. Read-only at runtime. Local working copies can be evolved.
3. **Configured external roots** — `externalSkillRoots` in profile config. Read-only.

The visible catalog is filtered per session using runtime conditions (platform, toolset availability, trust level). Visibility does not change mid-session; it refreshes on `/reset` or new session.

---

## SKILL.md Frontmatter

Every skill must have a `SKILL.md` file with YAML frontmatter:

```yaml
---
name: skill-name
description: What this skill does
---
```

Default fields applied when omitted:

| Field | Default |
|---|---|
| `version` | `0.1.0` |
| `requiredToolsets` | `["core"]` |
| `whenToUse` | The `description` value |

The skill name must be unique within the visible catalog. The description is used for skill selection and listing.

---

## Skills that need Python capabilities

Some skills need Python packages. EstaCoda handles those through registered Python capabilities.

A skill can declare a capability:

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

The declaration is intentionally small. A skill can name a registered capability and selected groups. It cannot define packages, imports, paths, versions, or install commands.

If a required capability is missing, the skill stays visible with setup/readiness metadata instead of disappearing from the session. The agent can explain the blocker and show the repair command. If an optional capability is missing, the skill can remain available with reduced behavior.

Set up a capability from the terminal:

```bash
estacoda python-env setup <id>
```

Check status:

```bash
estacoda python-env status <id>
```

Normal skill execution does not install Python packages automatically. On gateway surfaces such as Telegram, EstaCoda can ask the operator to approve installing a missing required managed Python capability for a selected skill. Approving installs only the registered capability packages and resumes the original request; denying leaves the capability uninstalled.

---

## Official Skills Catalog

The following official skills are bundled for v0.1.0:

| Skill | Purpose |
|---|---|
| `ascii-video` | Generate ASCII-art video representations |
| `telegram-media-analysis` | Analyze media received through Telegram |
| `youtube-knowledge-base` | Query and summarize YouTube content |

Official skills are read-only at runtime. They evolve through local working copies and governed review, not through in-session mutation.

---

## Visibility and Filtering

A skill is visible in a session only if:

- It is not archived or stale.
- Its platform restrictions match the current runtime.
- Its required toolsets are available.
- Its trust requirements are met.

Visibility is computed at session start and does not change until `/reset` or a new session. This prevents mid-session skill catalog drift.

---

## Execution Model

**Provider-backed:** By default, selected skill prompt content is injected into the system prompt and the provider executes the workflow. Skills under the inline cap are injected with their full root `SKILL.md` instructions. Oversized selected skills are represented as deterministic contracts instead of raw bodies silently truncated in the prompt.

**Deterministic fallback:** If no provider is available, a deterministic path executes the workflow steps directly.

**Resources:** `references/`, `templates/`, `scripts/`, and compatible `assets/` are indexed and loaded on demand. Resource contents are lazy and are not injected into prompts by default.

Full oversized root content can be recovered through the canonical skill retrieval tool:

```ts
skill.read({ "name": "<skill>", "mode": "full" })
```

A specific skill-local resource can be read by path:

```ts
skill.read({ "name": "<skill>", "path": "<relative-path>" })
```

`skill.search` is named-skill-only. It searches only the named skill's loaded `SKILL.md` instructions and indexed resources:

```ts
skill.search({ "name": "<skill>", "query": "<text>", "maxResults": 5 })
```

`skill.search` does not perform global skill search or nearby skill routing.

---

## Mutation and Evolution Boundaries

Skill evolution is governed, not autonomous. The system proposes changes; it does not silently apply them.

- **Pinned skills** cannot be mutated.
- **Authority expansion** is refused. A skill cannot grant itself broader permissions than it already has.
- **Eval gates** block promotion if eval fixtures fail.
- **Bundled skills** evolve only through local working copies.
- **External skills** remain read-only.

Proposed changes carry a `ChangeManifest` with hypothesis, predicted impact, risk level, and rollback plan. High-risk or untrusted proposals require explicit approval.

---

## Agent Evolution

Agent Evolution is the reviewable self-improvement control plane. It records evidence, learning candidates, governed proposals, eval metadata, optional experiment links, and review status. The persisted compatibility key is `skills.autonomy`; setup and settings show this as Agent Evolution.

| Mode | Behavior |
|---|---|
| `none` | Agent Evolution is off. No evidence or proposals are recorded. |
| `suggest` | Records evidence/candidates and creates reviewable proposal records. No promotion. |
| `proactive` | Prepares stronger review proposals and eval metadata. Promotion remains manual. |
| `autonomous` | Records shadow-only autonomous decisions for review. Real auto-promotion and auto-rollback are not active. |

`SkillLearningManager` is an evidence source, not mutation authority. `SkillEvolutionStore` owns evolution records such as observations, candidates, proposals, experiments, evals, promotions, snapshots, and rollback metadata. `ChangeManifestStore` owns change manifests. Bundled and external skill assets are not mutated.

Routing remains deterministic. Semantic retrieval, provider embeddings, LLM reranking, compact skill index fallback, taskClass routing, supporting candidates, advisory route tools, real autonomous promotion, auto-rollback, skill fork/merge/archive, and hygiene scanning are not active behavior.

---

## Agent-Facing Skill Operations

The agent can perform these operations via runtime tools:

| Operation | Purpose |
|---|---|
| `list` | List visible skills |
| `read` | Read skill instructions, contracts, metadata, or one skill-local resource. This is the canonical retrieval tool. |
| `search` | Search one named skill's root instructions and indexed resources. |
| `view` | Deprecated compatibility alias for `read` |
| `inspect` | Inspect skill metadata |
| `create` | Create a new skill |
| `patch` | Patch a skill file |
| `edit` | Edit a skill file |
| `delete` | Delete a skill |
| `write_file` | Write a file inside a skill |
| `remove_file` | Remove a file inside a skill |
| `import` | Import a skill from an external source |
| `export` | Export a skill |

---

## Failure Modes

**Skill not visible:** Check platform restrictions, toolset requirements, and trust level. Refresh with `/reset`.

**Skill execution fails:** Check that required resources exist and that the provider route is runnable.

**Skill mutation refused:** Pinned skills and authority-expanding mutations are refused by the mutation path.

**Agent Evolution disabled:** Check `skills.autonomy` in profile config. Default is `none`.

---

## Related

- [Architecture](../developer/architecture.md) — skill system in the runtime composition
- [Runtime](../developer/runtime.md) — skill registry and workflow execution
- [Memory](./memory.md) — Agent Evolution separation from memory files
