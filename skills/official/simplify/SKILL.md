---
{
  "name": "simplify",
  "description": "Review changed code for reuse, quality, and efficiency, then present findings for approval.",
  "version": "1.0.0",
  "category": "software-development",
  "routing": {
    "labels": ["code-review", "cleanup", "refactor-review"],
    "triggerPatterns": [
      { "type": "contains", "value": "/simplify" },
      { "type": "contains", "value": "review my code" },
      { "type": "contains", "value": "code review" },
      { "type": "contains", "value": "review changes" }
    ],
    "negativePatterns": [
      { "type": "contains", "value": "simplify the explanation" },
      { "type": "contains", "value": "simplify this text" },
      { "type": "contains", "value": "simplify the docs" }
    ],
    "requiredToolsets": ["files", "shell-readonly"],
    "confirmation": "policy",
    "priority": 30
  },
  "intentLabels": ["code-review", "cleanup", "refactor-review"],
  "triggerPatterns": ["/simplify", "review my code", "code review", "review changes"],
  "negativePatterns": ["simplify the explanation", "simplify this text", "simplify the docs"],
  "whenToUse": [
    "The user invokes /simplify or asks to review changed code.",
    "The user asks for a code review, cleanup, or efficiency audit of recent changes.",
    "The user wants to check for duplication, hacks, or performance issues in their diff."
  ],
  "requiredToolsets": ["files", "shell-readonly"],
  "optionalToolsets": ["research", "web"],
  "playbook": [
    {
      "id": "identify-changes",
      "description": "Run git diff (or git diff HEAD for staged changes) to see what changed. If there are no git changes, review the most recently modified files the user mentioned or that you edited earlier in this conversation.",
      "toolsets": ["shell-readonly"],
      "preferredTool": "terminal.run",
      "successCriteria": ["A clear diff or file list is available showing the changes to review."]
    },
    {
      "id": "search-existing-patterns",
      "description": "Search the codebase for existing utilities, helpers, and similar patterns that could relate to the changed code. Use file.search to find duplicates or existing abstractions.",
      "toolsets": ["files", "research"],
      "preferredTool": "file.search",
      "successCriteria": ["Relevant existing utilities and patterns are identified."]
    },
    {
      "id": "review-reuse",
      "description": "Review changes for code reuse opportunities: duplicated functionality, inline logic that could use existing utilities, and new functions that mirror existing ones.",
      "toolsets": ["files", "research"],
      "successCriteria": ["Reuse findings are documented with specific file references and recommendations."]
    },
    {
      "id": "review-quality",
      "description": "Review changes for quality issues: redundant state, parameter sprawl, copy-paste variation, leaky abstractions, stringly-typed code, unnecessary nesting, and unhelpful comments.",
      "toolsets": ["files", "research"],
      "successCriteria": ["Quality findings are documented with severity and rationale."]
    },
    {
      "id": "review-efficiency",
      "description": "Review changes for efficiency issues: unnecessary work, missed concurrency, hot-path bloat, no-op updates, unnecessary existence checks, memory leaks, and overly broad operations.",
      "toolsets": ["files", "research"],
      "successCriteria": ["Efficiency findings are documented with severity and rationale."]
    },
    {
      "id": "aggregate-report",
      "description": "Aggregate all findings into a structured report. Present findings to the user for approval before making any edits. Do not auto-fix.",
      "toolsets": ["files"],
      "successCriteria": ["User receives a structured review report and can approve or reject each recommendation."]
    },
    {
      "id": "apply-approved-fixes",
      "description": "Only after explicit user approval, apply the approved fixes. If a finding is rejected, skip it with a brief note.",
      "toolsets": ["files", "shell-write"],
      "successCriteria": ["Only approved changes are applied and summarized."]
    }
  ],
  "permissionExpectations": ["auto-read", "ask-before-write"],
  "examples": [
    "/simplify",
    "Review my code for quality issues.",
    "Review the changes I just made.",
    "Check if my refactor introduced any duplication or inefficiency."
  ],
  "evaluations": [
    {
      "input": "/simplify",
      "shouldUseToolsets": ["files", "shell-readonly"],
      "shouldNotAskUserFirst": true,
      "expectedOutcome": "The agent identifies changes via git diff, searches for existing patterns, reviews reuse/quality/efficiency, presents a structured report, and only fixes after user approval."
    }
  ]
}
---

# Simplify: Code Review

Review all changed files for reuse, quality, and efficiency. Present findings for approval before making any edits.

## Phase 1: Identify Changes

Run `git diff` (or `git diff HEAD` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Search Existing Patterns

Search the codebase for existing utilities, helpers, and similar patterns using `file.search`. Find:

- Existing functions that duplicate new logic
- Utility directories and shared modules
- Common patterns adjacent to changed files

## Phase 3: Review

### Reuse Review

For each change:

1. **Search for existing utilities and helpers** that could replace newly written code.
2. **Flag any new function that duplicates existing functionality.** Suggest the existing function to use instead.
3. **Flag any inline logic that could use an existing utility** — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns.

### Quality Review

Review the same changes for hacky patterns:

1. **Redundant state**: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls
2. **Parameter sprawl**: adding new parameters to a function instead of generalizing or restructuring existing ones
3. **Copy-paste with slight variation**: near-duplicate code blocks that should be unified with a shared abstraction
4. **Leaky abstractions**: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries
5. **Stringly-typed code**: using raw strings where constants, enums (string unions), or branded types already exist in the codebase
6. **Unnecessary JSX nesting**: wrapper elements that add no layout value
7. **Unnecessary comments**: comments explaining WHAT the code does (well-named identifiers already do that), narrating the change, or referencing the task/caller — delete; keep only non-obvious WHY (hidden constraints, subtle invariants, workarounds)

### Efficiency Review

Review the same changes for efficiency:

1. **Unnecessary work**: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns
2. **Missed concurrency**: independent operations run sequentially when they could run in parallel
3. **Hot-path bloat**: new blocking work added to startup or per-request/per-render hot paths
4. **Recurring no-op updates**: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers are not notified when nothing changed
5. **Unnecessary existence checks**: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error
6. **Memory**: unbounded data structures, missing cleanup, event listener leaks
7. **Overly broad operations**: reading entire files when only a portion is needed, loading all items when filtering for one

## Phase 4: Report

Aggregate all findings into a structured report:

```md
# Review Report

## Reuse
- Finding: ... | Severity: ... | Recommendation: ...

## Quality
- Finding: ... | Severity: ... | Recommendation: ...

## Efficiency
- Finding: ... | Severity: ... | Recommendation: ...
```

Present the report to the user. Do not make any edits until the user explicitly approves specific fixes.

## Phase 5: Apply Approved Fixes Only

After explicit user approval:

- Apply only the approved fixes
- Skip rejected findings with a brief note
- Summarize what was changed

## Rules

- Never auto-fix. Always present findings and ask for approval.
- If the code is already clean, say so clearly.
- Cite specific files and line ranges for each finding.
