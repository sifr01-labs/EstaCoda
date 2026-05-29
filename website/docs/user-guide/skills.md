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

**Provider-backed:** By default, skill instructions are injected into the system prompt and the provider executes the workflow.

**Deterministic fallback:** If no provider is available, a deterministic path executes the workflow steps directly.

**Resources:** `references/`, `templates/`, `scripts/`, and compatible `assets/` are indexed and loaded on demand.

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

Agent Evolution controls whether EstaCoda may learn reusable Skills from workflow patterns. The persisted config key is `skills.autonomy`; setup and settings show this as Agent Evolution.

| Mode | Behavior |
|---|---|
| `none` | Agent Evolution is off |
| `suggest` | Records candidates after repeated success; does not write files |
| `proactive` | Auto-creates project skills after repeated successful bounded local workflows |
| `autonomous` | Auto-creates after first successful bounded local workflow |

Learning and autonomy are maturity-bounded. They create local skills only for detected bounded workflows. They do not imply a marketplace or a broad bundled catalog.

---

## Agent-Facing Skill Operations

The agent can perform these operations via runtime tools:

| Operation | Purpose |
|---|---|
| `list` | List visible skills |
| `view` | View a skill's content |
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
