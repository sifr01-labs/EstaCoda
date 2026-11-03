Source review confirms write-capable defaults and key non-escalation guards. A conditional dispatch-authority gap needs follow-up. Tests were NOT EXECUTED.

## Review boundary

Reviewed the requested delegation defaults, tool-access security implementation, Task approval service, relevant tests, and the Task executor’s authority filter. Skill-tools were excluded.

The manifest identifies the baseline and changed-source hashes and limits the stated comparison; hashes were not independently verified. **Evidence:** `MANIFEST.json:2–24`.

The failed executor search was an invalid-argument error, not an access denial. A corrected search and subsequent file read obtained the relevant evidence. No finding depends on the failed search.

## Findings

### Medium, conditional — Dispatch revalidation omits explicit tool-specific authority checks

The approval service rereads Task, Step, and Attempt records before dispatch. It checks terminal Task status, active plan revision, lease fencing, approval identity, command hardline floor, and the current narrowed decision.
**Evidence:** `src/tasks/task-approval-service.ts:111–125`.

That narrowed decision enforces report-delivery target restrictions and Task/Step risk-class dispositions, but does not explicitly check `allowedTools`, `allowedToolsets`, or `blockedTools`. Those restrictions appear in the executor’s separate tool filter.
**Evidence:** `src/tasks/task-approval-service.ts:264–291`; `src/tasks/agent-step-executor.ts:587–607`.

**Conditional risk:** If tool-specific authority can change within the same plan revision after runtime construction, a previously exposed tool could remain dispatch-eligible despite a name/toolset revocation, provided its risk class remains permitted.

**Limit:** This is not a demonstrated bypass. The reviewed evidence does not establish that such mutations are possible or rule out protection elsewhere.

**Release action:** Demonstrate authority immutability during this interval, or add dispatch-time tool-authority validation and an assessment-to-dispatch revocation regression test.

### Medium — Default delegation exposure is not read-only

Defaults allow `workspace-write`, alongside local and network reads. The default toolset allowlist is empty; browser, media, and MCP are excluded. The source comment correctly distinguishes exposure from execution authorization.
**Evidence:** `src/config/delegation-defaults.ts:17–20`.

The tests expressly expect `terminal.run` and `file.write` under default child access. They also verify that an operator-specified read-only ceiling excludes both, even when requested explicitly.
**Evidence:** `src/delegation/toolset-security.test.ts:8–30`.

**Release action:** Describe this as write-capable inheritance subject to Task/runtime authorization—not read-only delegation. This is an intentional permission posture, not itself evidence of an approval bypass.

### Low — Targeted negative-test coverage is incomplete

The inspected Task-step resolver tests cover write-tool retention and delegation permission, but not Task-step-specific parent-invisibility or empty-allowlist cases.
**Evidence:** `src/delegation/toolset-security.test.ts:129–165`.

The inspected approval tests cover durable asks, base denial, report-delivery restrictions, session-scoped pending queries, dispatch consumption, second-receipt rejection, and action-identity retention. They do not directly exercise:

- Terminal status, plan revision, or lease changes between assessment and dispatch.
- Approval expiry.
- Cross-session approval-resolution rejection.

**Test evidence:** `src/tasks/task-approval-service.test.ts:9–118`, `src/tasks/task-approval-service.test.ts:181–237`.
**Corresponding implementation:** `src/tasks/task-approval-service.ts:111–125`, `src/tasks/task-approval-service.ts:175–198`, `src/tasks/task-approval-service.ts:294–297`.

These are coverage gaps, not proof that the protections fail. No claim is made about coverage elsewhere in the repository.

## Supported security boundaries

| Boundary | Repository evidence |
|---|---|
| Child access remains within parent visibility; explicit tool/toolset requests narrow access | `src/delegation/toolset-security.ts:96–119`, `src/delegation/toolset-security.ts:183–222`; tests at `src/delegation/toolset-security.test.ts:33–78` |
| Explicit requests cannot override exact-name or prefix blocks | `src/delegation/toolset-security.ts:188–199`; tests at `src/delegation/toolset-security.test.ts:80–99` |
| Child delegation requires orchestrator role below maximum depth | `src/delegation/toolset-security.ts:180–193`; tests at `src/delegation/toolset-security.test.ts:101–125` |
| Task approval cannot override base denial or Task/Step risk prohibition | `src/tasks/task-approval-service.ts:271–291`; base-denial test at `src/tasks/task-approval-service.test.ts:31–48` |
| Approval fingerprints include action key, tool, risk, target, summary, and command hash; matching approvals must be unexpired | `src/tasks/task-approval-service.ts:294–297`, `src/tasks/task-approval-service.ts:376–390` |
| Approval consumption occurs at dispatch and rejects a second assessed receipt | `src/tasks/task-approval-service.ts:123–125`, `src/tasks/task-approval-service.ts:250–261`; test at `src/tasks/task-approval-service.test.ts:181–207` |

Some returned fixture values were redacted, limiting independent comparison of exact target/action values.

## Test execution and release limits

```sh
pnpm exec vitest run --config vitest.node.config.ts src/delegation/toolset-security.test.ts src/tasks/task-approval-service.test.ts
```

- **Status: NOT EXECUTED**
- **Exit code: unavailable**
- **Executed/pass/fail counts: unavailable**
- **Blocker:** Only read/search capabilities were granted. Successful file-tool receipts do not establish test execution.

Files were preserved; no installations, network access, personal-state access, or execution bypasses were attempted.

This review provides source evidence, not passing-test evidence or end-to-end security certification. Release readiness remains unverified until authorized test execution and resolution of the conditional dispatch-authority question.
