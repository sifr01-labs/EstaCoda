Static review found two security follow-ups. The inspected code includes admission and approval safeguards, but requested tests remain unexecuted and release readiness is unverified.

## Scope and evidence

**Assigned scope:** `delegation-security-approval-review`.

Inspected delegation defaults, tool-access filtering, the Task approval boundary, and relevant tests/callsites. Skill-tools were excluded. Source and tests were preserved; no installation, network access, personal-state inspection, or execution workaround was attempted.

`MANIFEST.json:4–14` identifies the updated delegation sources/tests. The explicitly requested Task approval service and supporting runtime/executor callsites were reviewed as boundary evidence, not additional manifest changes. Manifest hashes were not independently verified.

The malformed grep and nonexistent `task-host.ts` lookup produced no evidence. Their research needs were subsequently covered by successful reads/searches of the approval tests and `agent-step-executor.ts`.

## Security findings

### 1. Dispatch revalidation does not explicitly recheck the complete current tool ceiling

**Priority: medium, conditional gap—not a demonstrated exploit.**

Initial admission intersects Task/Step allowed tool names, toolsets, blocked names, risk dispositions, and delegation authority (`src/tasks/agent-step-executor.ts:587–607`). Filtered parent-visible tools and the approval-wrapped policy feed child construction (`src/tasks/agent-step-executor.ts:191–209`).

Dispatch validation reloads Task, Step, and Attempt, checking terminal Task status, active revision, fencing token, exact approval identity, hardline command restrictions, and a renewed policy decision (`src/tasks/task-approval-service.ts:112–125`).

However:

- The narrowing function rechecks risk dispositions and report-delivery targets, not current `allowedTools`, `allowedToolsets`, `blockedTools`, or delegation permissions (`src/tasks/task-approval-service.ts:264–291`).
- The dispatch guard contains no explicit Step/Attempt terminal-status check (`src/tasks/task-approval-service.ts:117–123`).

**Potential consequence:** if those authorities or execution statuses can change without replacing the checked revision/token, an earlier admitted operation may remain dispatchable. This review did not establish whether lifecycle invariants prevent that transition.

**Follow-up:** test authority/status mutations between assessment and dispatch. Either reject dispatch or establish that every relevant change invalidates the revision/token.

### 2. Eligible orchestrators bypass the configured exact-name block for `delegate_task`

**Priority: policy ambiguity; confirmed special-case behavior.**

Defaults include `"delegate_task"` in `blockedToolNames` (`src/config/delegation-defaults.ts:21–26`). The resolver handles that tool separately: an orchestrator below maximum depth bypasses the exact-name blocking branch and default risk restriction (`src/delegation/toolset-security.ts:183–204`).

The test expressly expects an eligible orchestrator to receive `delegate_task` while retaining that default blocked-name configuration (`src/delegation/toolset-security.test.ts:100–123`).

**Consequence:** `blockedToolNames` is not an unconditional administrative deny for this tool.

**Follow-up:** document the exception or enforce a separate administrative deny, tested independently of role/depth eligibility.

## Safeguards supported by inspection

- **Parent visibility remains a ceiling.** Defaults allow workspace-write while excluding browser/media/MCP and selected sensitive names/prefixes; explicit requests cannot override those restrictions (`src/config/delegation-defaults.ts:17–34`; `src/delegation/toolset-security.ts:185–225`).
- **Matching candidates use parent metadata**, rather than replacement candidate classifications (`src/delegation/toolset-security.ts:106–110`).
- **Task execution intentionally avoids reapplying delegation defaults.** Its security depends on the preceding persisted-authority filter as well as runtime policy (`src/delegation/toolset-security.ts:47–69`; `src/runtime/agent-loop-factory.ts:294–309`; `src/tasks/agent-step-executor.ts:587–607`).
- **Approval cannot override base denial or Task/Step risk forbids** (`src/tasks/task-approval-service.ts:271–291`).
- **Approval fingerprints bind action identity, tool, risk, target, summary, and command hash** (`src/tasks/task-approval-service.ts:373–386`).
- **Approval resolution is session/profile scoped**, and matching approval consumption occurs at dispatch (`src/tasks/task-approval-service.ts:172–194`, `249–261`).

## What the tests establish—and leave open

These are **statically inspected assertions, not passing-test claims**.

| Evidence | Assertions present | Limitations |
|---|---|---|
| `src/delegation/toolset-security.test.ts:8–98` | Operator read-only ceiling; default write/execution exposure; parent visibility; tool/toolset intersection; blocked names/prefixes | Synthetic inventory, not runtime dispatch |
| `src/delegation/toolset-security.test.ts:100–164` | Orchestrator/depth handling; Task write-tool retention; Task delegation flag | No dispatch-time authority mutation coverage |
| `src/tasks/task-approval-service.test.ts:10–83` | Durable ask; base denial preservation; report-delivery restrictions; no tool approval queued for unnamed assessments | Redacted target literals limit independent verification of exact path cases |
| `src/tasks/task-approval-service.test.ts:85–121` | Session filtering supplied to the store before the page limit | Mocked store, not end-to-end queue authorization |
| `src/tasks/task-approval-service.test.ts:181–203` | Dispatch consumes approval; second in-flight receipt is rejected | Does not establish cross-process atomicity |
| `src/tasks/task-approval-service.test.ts:205–231` | Identity retention after 23 hours; changed content requires approval; consumed approval cannot replay | Does not establish actual expiration or restart recovery |

The requested files do not establish end-to-end queue reconciliation, cross-process consumption, or the authority-mutation cases above.

## Execution receipt and release readiness

Requested command:

```text
pnpm exec vitest run --config vitest.node.config.ts src/delegation/toolset-security.test.ts src/tasks/task-approval-service.test.ts
```

**Requested test execution is incomplete. No exit-code or executed-test-count receipt is available.** The parent’s terminal/process denial was respected; no bypass was attempted.

**Disposition:** static review complete; release verification incomplete. Remaining gates are authorized execution of the requested tests and resolution—or explicit acceptance—of the conditional dispatch-authority gap and administrative-deny ambiguity.
