---
{
  "name": "remember",
  "description": "Review EstaCoda memory entries and propose promotions, cleanup, deduplication, and conflict fixes across memory layers.",
  "version": "1.0.0",
  "category": "productivity",
  "routing": {
    "labels": ["memory-review", "memory-hygiene", "memory-promotion"],
    "triggerPatterns": [
      { "type": "contains", "value": "/remember" },
      { "type": "contains", "value": "review memory" },
      { "type": "contains", "value": "clean up memory" },
      { "type": "contains", "value": "promote memory" },
      { "type": "contains", "value": "memory hygiene" },
      { "type": "contains", "value": "dedupe memory" }
    ],
    "negativePatterns": [
      { "type": "contains", "value": "remember me" },
      { "type": "contains", "value": "do you remember" },
      { "type": "contains", "value": "remember that" }
    ],
    "requiredToolsets": ["memory", "research"],
    "confirmation": "ask",
    "priority": 25
  },
  "intentLabels": ["memory-review", "memory-hygiene"],
  "triggerPatterns": ["/remember", "review memory", "clean up memory", "promote memory", "memory hygiene", "dedupe memory"],
  "negativePatterns": ["remember me", "do you remember", "remember that"],
  "whenToUse": [
    "The user invokes /remember.",
    "The user wants to review, organize, clean up, or promote memory entries.",
    "The user wants to detect outdated, conflicting, duplicate, or misplaced memory."
  ],
  "requiredToolsets": ["memory", "research"],
  "optionalToolsets": [],
  "playbook": [
    {
      "id": "gather-memory-layers",
      "description": "Read the active profile's memory entries using memory.read and memory.search. Inspect promotion metadata or memory diagnostics if available via memory.curate. Do not treat AGENTS.md as memory.",
      "toolsets": ["memory"],
      "preferredTool": "memory.read",
      "successCriteria": ["The contents or absence of all relevant memory layers are known."]
    },
    {
      "id": "classify-entries",
      "description": "Classify each substantive memory entry by best destination: user profile, personal memory, agent persona, shared/team memory if configured, or stay as temporary/auto-memory. Flag ambiguous entries instead of guessing.",
      "toolsets": ["research"],
      "successCriteria": ["Each entry has a proposed destination, no-action status, or ambiguity flag."]
    },
    {
      "id": "detect-cleanup",
      "description": "Scan across all memory layers for duplicates, outdated entries, conflicts, stale instructions, and entries that should not be in durable memory. Use memory.search to find duplicates.",
      "toolsets": ["memory", "research"],
      "preferredTool": "memory.search",
      "successCriteria": ["All cross-layer issues are identified and grouped by action type."]
    },
    {
      "id": "present-report",
      "description": "Present a structured report grouped by promotions, cleanup, ambiguous entries, and no action needed. Do not modify memory until the user approves specific changes.",
      "toolsets": ["research"],
      "successCriteria": ["User can approve, reject, or edit each proposed memory change individually."]
    },
    {
      "id": "apply-approved-changes",
      "description": "Only after explicit approval, apply the approved memory changes using safe targeted edits. Use memory tools or file editing as appropriate. Never compact agent persona or AGENTS.md. Never persist secrets or one-off temporary facts.",
      "toolsets": ["memory"],
      "successCriteria": ["Only approved memory changes are applied and summarized."]
    }
  ],
  "permissionExpectations": ["auto-read", "ask-before-write"],
  "examples": [
    "/remember",
    "Review my memory entries.",
    "Clean up duplicate memory.",
    "Which memories should be promoted or removed?"
  ],
  "evaluations": [
    {
      "input": "/remember",
      "shouldUseToolsets": ["memory", "research"],
      "shouldNotAskUserFirst": false,
      "expectedOutcome": "The agent reads memory layers using memory tools, classifies entries, identifies cleanup, presents proposals, and applies only approved changes."
    }
  ]
}
---

# Remember: Memory Review

## Goal

Review the user's EstaCoda memory landscape and produce a clear report of proposed changes, grouped by action type. Do not apply changes until the user explicitly approves them.

## EstaCoda Memory Layers

| Destination | What belongs there | Examples |
|---|---|---|
| **User profile** | User preferences, communication style, durable personal preferences | "User prefers concise responses", "User wants exact source verification" |
| **Personal memory** | Stable facts, project conventions, durable environment notes, reusable lessons | "Repo uses pnpm", "VPS hostname is ...", "Project plans go to private workspace" |
| **Agent persona** | Agent identity/persona only | The assistant's stable personality or role definition |
| **Shared/team memory** | Org-wide knowledge that applies across profiles/repos, only if configured | Team deployment conventions, org-wide service ownership |
| **No durable memory** | Temporary task state, stale artifacts, PR numbers, issue numbers, one-off progress | "Fixed bug X", "PR #123", "phase 8 done" |

Important:

- `AGENTS.md` is project context, not memory. Do not curate, compact, promote, or mirror it as learned memory.
- Agent persona is protected identity/persona. Do not compact or casually edit it.
- Secrets must never be persisted into memory.
- If a fact will probably be stale in a week, it does not belong in durable memory.

## Steps

### 1. Gather all memory layers

Use memory tools to inspect the active profile's memory:

- `memory.read` for current entries
- `memory.search` for related or duplicate entries
- `memory.curate` for promotion metadata or diagnostics if available

Also note whether shared memory is configured.

**Success criteria**: You have the contents or absence of all relevant memory layers and can compare them.

### 2. Classify each substantive entry

For each entry, determine the best destination:

- User profile
- Personal memory
- Agent persona
- Shared/team memory
- Stay temporary / no durable memory
- Ambiguous — ask the user

**Success criteria**: Each entry has a proposed destination or is flagged as ambiguous.

### 3. Identify cleanup opportunities

Scan for:

- **Duplicates**: same fact repeated across layers
- **Outdated entries**: contradicted by newer source-verified facts
- **Conflicts**: incompatible instructions or facts
- **Misplaced entries**: user preferences in personal memory, project facts in user profile, identity text outside agent persona
- **Stale artifacts**: task progress, PR numbers, issue numbers, completed-work logs
- **Sensitive data**: secrets, tokens, credentials, private URLs that should not be persisted

**Success criteria**: All cross-layer issues are identified.

### 4. Present the report

Output a structured report grouped by action type:

1. **Promotions** — entries to move, destination, and rationale
2. **Cleanup** — duplicates, outdated entries, conflicts, or stale entries to remove/update
3. **Ambiguous** — entries where user input is needed
4. **No action needed** — brief note on entries that should stay where they are

If memory is empty, say so and offer to review project context instead.

**Success criteria**: The user can review and approve/reject each proposal individually.

### 5. Apply approved changes only

After explicit user approval:

- Use targeted edits via memory tools or safe file edits
- Preserve unrelated content
- Do not create new files unless the target does not exist yet and the user approved creation
- Do not edit AGENTS.md as memory
- Do not compact or casually rewrite agent persona

**Success criteria**: Only approved changes are applied, and the final summary lists exactly what changed.

## Rules

- Present all proposals before making any changes.
- Do not modify memory without explicit approval.
- Ask about ambiguous entries — do not guess.
- Do not promote one-off preferences or task progress into durable memory.
- Never persist secrets.
