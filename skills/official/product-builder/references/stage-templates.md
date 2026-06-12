# Stage Templates

Detailed templates for each stage of product builder control.

## Idea stage

```md
# Product Definition

Problem:
Target user:
Core use case:
Primary workflow:
Success condition:
Non-goals:
Reference products:
```

Also identify whether the product is being approached problem-first or function-first.

## Research stage

```md
# Research Map

Known facts:
Common patterns:
Reference products:
Open questions:
Unknowns that matter:
Unknowns that do not matter yet:
```

Keep facts separate from interpretation.

## Engine stage

```md
# Engine Map

Input:
Processing:
Storage:
Output:
External dependencies:
Failure points:
Human approval points:
```

This is the minimum system understanding a non-technical builder needs before directing agents.

## Decision-gate stage

```md
# Decision Log Entry

Decision:
Date:
Context:
Options:
Chosen option:
Why:
Rejected options:
Downstream impact:
Reversibility:
Trigger for reconsideration:
```

For unresolved decisions, use:

```md
# Decision Gate

Decision required:
Options:
Option A:
  Benefits:
  Risks:
  Downstream impact:
  Reversibility:
Option B:
  Benefits:
  Risks:
  Downstream impact:
  Reversibility:
Reference products:
Recommended default:
What evidence would change the decision:
```

## PRD stage

```md
# PRD

## Phase 1: Thin Vertical Slice

Goal:
User-visible behavior:
Technical requirements:
Non-goals:
Acceptance criteria:
Tests:
Risks:

## Phase 2

Goal:
User-visible behavior:
Technical requirements:
Non-goals:
Acceptance criteria:
Tests:
Risks:
```

Phase 1 should normally be one end-to-end workflow that proves the core product loop.

## Builder-agent stage

```md
# Builder Agent Brief

You are implementing the attached PRD.

Rules:
- Build the smallest working vertical slice first.
- Preserve existing architecture boundaries.
- Avoid hidden global state.
- Avoid unnecessary dependencies.
- Work in small commits.
- After each meaningful change, run the project's validation commands.
- If a decision is required, present options with downstream impact and reversibility.
- Update the decision log and architecture notes when implementation changes the plan.

Before editing:
1. Inspect the relevant contracts, runtime, config, tests, and docs.
2. Produce a short implementation plan.
3. Identify files likely to change.
4. Identify risks.

Implementation plan format:
- Goal:
- Files likely to change:
- Steps:
- Risks:
- Validation commands:
- Rollback plan:
```

Adapt validation commands to the repo. If unknown, ask the builder to inspect package scripts, test config, CI files, or README.

## Documentation stage

After the first vertical slice, create or update:

```md
Architecture map:
Dependency map:
Environment setup:
README:
Roadmap:
Testing plan:
Internal alpha plan:
Risk register:
Decision log:
```

The dependency map should answer:

```md
If we change X, what files/modules are affected?
What depends on this?
What breaks if this abstraction changes?
Which tests cover it?
Which runtime flows hit it?
Where are circular dependencies forming?
```

## Reviewer-agent stage

Use separate reviewer roles. Do not ask every agent to review everything.

Recommended roles:

```md
Architecture reviewer:
Security and reliability reviewer:
Product and use-case reviewer:
Testing and validation reviewer:
```

Reviewer prompt:

```md
# Reviewer Agent Brief

Review the source code and documentation independently.

Focus on:
- Architecture correctness
- Security and reliability
- Product fit
- Testing gaps
- Hidden assumptions
- Downstream risk

Return findings in this format:

Finding:
Severity:
Evidence:
Why it matters:
Recommended change:
Risk if ignored:
Confidence:
```

Severity scale:

```md
Critical: blocks safety, data integrity, or core functionality.
High: likely to cause architectural drift, security weakness, or broken user workflow.
Medium: important but not immediately blocking.
Low: polish, clarity, or cleanup.
```

## Review-comparison stage

```md
# Review Comparison

Where reviewers agree:
Where reviewers disagree:
Reason for disagreement:
Evidence needed:
Decision required:
Recommended default:
Risks:
Reversibility:
```

Do not collapse disagreement into fake consensus. If evidence is insufficient, state that the decision should be staged or deferred.

## Builder-response stage

```md
# Builder Response Request

Respond to the reviewer findings.

For each recommendation:

Recommendation:
Accept / reject / modify:
Reason:
Files affected:
Implementation plan:
Tests:
Rollback plan:
```

The builder should not blindly obey reviewers. It should justify every acceptance, rejection, or modification.

## Milestone-review stage

```md
# Milestone Review

What works:
What is fragile:
What changed from the original PRD:
What decisions were made:
What debt was created:
What should be deleted:
What should be deferred:
What is the next vertical slice:
```

Use this at major project transitions, before large refactors, before changing builder agents, and before internal alpha.

## Product-control stage

```md
# PRODUCT_CONTROL.md

## Current Product Thesis

## Current Architecture Summary

## Current Roadmap

## Current Decision Log

## Open Risks

## Known Debt

## Current Validation Commands

## Next Milestone

## Do-Not-Build List
```

The source-of-truth artifact should be short enough to stay maintained. If it becomes too long, split detailed references into separate docs and keep `PRODUCT_CONTROL.md` as the index.
