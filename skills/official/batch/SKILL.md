---
{
  "name": "batch",
  "description": "Research and plan a large-scale change across a codebase. Produces a decomposed plan with verification recipes, ready for user approval before execution.",
  "version": "1.0.0",
  "category": "software-development",
  "routing": {
    "labels": ["batch-change", "migration", "large-refactor"],
    "triggerPatterns": [
      { "type": "contains", "value": "/batch" },
      { "type": "contains", "value": "migration across codebase" },
      { "type": "contains", "value": "refactor across" },
      { "type": "contains", "value": "bulk rename" },
      { "type": "contains", "value": "replace all uses of" }
    ],
    "negativePatterns": [
      { "type": "contains", "value": "batch process" },
      { "type": "contains", "value": "batch file" },
      { "type": "contains", "value": "batch job" }
    ],
    "requiredToolsets": ["files", "shell-readonly", "research"],
    "confirmation": "ask",
    "priority": 20
  },
  "intentLabels": ["batch-change", "migration"],
  "triggerPatterns": ["/batch", "migration across codebase", "refactor across", "bulk rename", "replace all uses of"],
  "negativePatterns": ["batch process", "batch file", "batch job"],
  "whenToUse": [
    "The user invokes /batch with an instruction.",
    "The user wants to make a sweeping, mechanical change across many files.",
    "The user asks to migrate, rename, or refactor across the entire codebase."
  ],
  "requiredToolsets": ["files", "shell-readonly", "research"],
  "optionalToolsets": ["web", "browser"],
  "playbook": [
    {
      "id": "validate-git",
      "description": "Check that we are inside a git repository. If not, explain that /batch requires git and stop.",
      "toolsets": ["shell-readonly"],
      "preferredTool": "terminal.run",
      "successCriteria": ["Confirmed git repository or stopped with clear explanation."]
    },
    {
      "id": "research-plan",
      "description": "Research the scope deeply. Find all files, patterns, and call sites that need to change. Understand existing conventions so the migration is consistent. Use file.search and terminal.run as needed.",
      "toolsets": ["files", "shell-readonly", "research"],
      "successCriteria": ["Complete understanding of all touched files, patterns, and conventions."]
    },
    {
      "id": "decompose",
      "description": "Break the work into 5–30 self-contained units. Each unit must be independently implementable, mergeable on its own, and roughly uniform in size. Prefer per-directory or per-module slicing.",
      "toolsets": ["files", "shell-readonly"],
      "successCriteria": ["Numbered list of work units with title, file list, and one-line change description for each."]
    },
    {
      "id": "determine-verification",
      "description": "Figure out how a worker can verify its change end-to-end. Look for browser-automation, CLI-verifier, dev-server + curl, or existing e2e/integration test suites. If no concrete e2e path exists, ask the user. Write the recipe as concrete steps.",
      "toolsets": ["files", "shell-readonly"],
      "successCriteria": ["A short, concrete verification recipe is documented, or user explicitly chose to skip e2e."]
    },
    {
      "id": "present-plan",
      "description": "Present the full plan to the user for approval. Include research summary, work units, verification recipe, and shared worker instructions. Ask before proceeding.",
      "toolsets": ["files"],
      "successCriteria": ["User has approved the plan, or plan was edited and re-approved."]
    }
  ],
  "permissionExpectations": ["auto-read", "ask-before-write", "ask-before-external-send"],
  "examples": [
    "/batch migrate from react to vue",
    "/batch replace all uses of lodash with native equivalents",
    "/batch add type annotations to all untyped function parameters"
  ],
  "evaluations": [
    {
      "input": "/batch migrate from react to vue",
      "shouldUseToolsets": ["files", "shell-readonly", "research"],
      "shouldNotAskUserFirst": false,
      "expectedOutcome": "The agent validates git, researches scope, decomposes into units, determines verification, presents plan for approval, and stops. Execution is left to the user or separate sessions."
    }
  ]
}
---

# Batch: Large-Scale Change Planning

Research and plan a large, parallelizable change across this codebase. This skill produces a decomposed plan ready for user approval. Actual execution happens in separate sessions or via `delegate_task` one unit at a time.

## User Instruction

The user's instruction is passed as the routed text or skill arguments.

## Phase 1: Research and Plan

1. **Understand the scope.** Research what this instruction touches. Find all the files, patterns, and call sites that need to change. Understand the existing conventions so the migration is consistent. Use `file.search` and `terminal.run` as needed.

2. **Decompose into independent units.** Break the work into 5–30 self-contained units. Each unit must:
   - Be independently implementable (no shared state with sibling units)
   - Be mergeable on its own without depending on another unit landing first
   - Be roughly uniform in size (split large units, merge trivial ones)

   Scale the count to the actual work: few files → closer to 5; hundreds of files → closer to 30. Prefer per-directory or per-module slicing over arbitrary file lists.

3. **Determine the e2e test recipe.** Figure out how a worker can verify its change actually works end-to-end — not just that unit tests pass. Look for:
   - A browser-automation skill or tool (for UI changes: click through the affected flow, screenshot the result)
   - A CLI-verifier pattern (for CLI changes: launch the app interactively, exercise the changed behavior)
   - A dev-server + curl pattern (for API changes: start the server, hit the affected endpoints)
   - An existing e2e/integration test suite the worker can run

   If you cannot find a concrete e2e path, ask the user how to verify this change end-to-end. Offer 2–3 specific options based on what you found.

   Write the recipe as a short, concrete set of steps that a worker can execute autonomously. Include any setup (start a dev server, build first) and the exact command/interaction to verify.

4. **Write the plan.** In your plan message, include:
   - A summary of what you found during research
   - A numbered list of work units — for each: a short title, the list of files/directories it covers, and a one-line description of the change
   - The e2e test recipe (or "skip e2e because …" if the user chose that)
   - The exact worker instructions you will give each agent (the shared template)

5. **Present the plan for approval.** Ask the user before proceeding. Options: Approve, Edit plan, Cancel.

## Phase 2: Execution (After Plan Approval)

Once the plan is approved, you have two options:

1. **Execute sequentially yourself** — work through each unit in this session, applying the changes directly.
2. **Delegate one unit at a time** — use `delegate_task` with a single `task` per call. Each prompt must be fully self-contained. Include:
   - The overall goal (the user's instruction)
   - This unit's specific task (title, file list, change description — copied verbatim from your plan)
   - Any codebase conventions you discovered that the worker needs to follow
   - The e2e test recipe from your plan (or "skip e2e because …")
   - Standard worker instructions:

```
After you finish implementing the change:
1. Run unit tests — Run the project's test suite. If tests fail, fix them.
2. Test end-to-end — Follow the e2e test recipe from the coordinator's prompt. If the recipe says to skip e2e for this unit, skip it.
3. Report — End with a summary of what changed and whether tests passed.
```

**Note:** EstaCoda's `delegate_task` takes a single `task` per call. Parallel execution requires multiple separate calls. Track progress manually if delegating.

## Rules

- Do not start making changes until the user approves the plan.
- Each work unit must be self-contained and independently verifiable.
- Always include a concrete e2e verification recipe or explicit user opt-out.
- If the scope is unclear, research first before decomposing.
