---
title: "Execution authority and approval reuse"
description: "Verified execution facts, scoped approvals, renewal, and revocation."
---

# Execution authority and approval reuse

EstaCoda defaults to Local host and supports [optional Docker execution](docker-execution.md). A configured environment label does not establish a sandbox or reduce command risk. Ordinary trusted host workflows remain available under the selected security mode; hardline blocks and deterministic denials still take precedence over approvals.

## Host facts and requested controls

Runtime construction verifies the canonical workspace directory and produces core-owned host facts. These report read/write host access, unrestricted command networking, no filesystem or network containment, unverified inherited credential isolation, host lifetime, and unverified resource limits. Existing tool-specific safety checks and limits still apply; these facts do not claim an environment-wide guarantee.

The programmatic `requestedExecutionPolicy` option supports mandatory and advisory controls. A mandatory unsupported control, such as network disablement, read-only host containment, credential isolation, session lifetime or aggregate resource limits, blocks runtime construction. An advisory unsupported control appears as a degradation in `runtime.executionFacts()`. An unsupported backend never silently falls back to host execution. These are core runtime contracts; the Setup Editor now records Docker backend, bind and networking choices through reviewed apply.

The stable authority fingerprint includes the actual host policy and canonical workspace identity. Display names, workspace aliases, verification timestamps and process instance IDs do not change reusable authority. Host facts cannot be established by copying JSON into tool input.

## What an approval covers

| Approval | Binding and reuse |
|---|---|
| Pending local/channel action | Exact action token, profile, Session, surface, workspace, host authority, process instance, authorization revision and expiry |
| `once` | The reviewed action only; consumed once |
| `session` | Matching tool, risk and normalized target in the same Session/process and execution scope |
| `always` | Matching tool, risk and normalized target under the same profile, surface, workspace and verified authority; can survive a new Session/process |
| Durable Task approval | Existing Task/plan/step/Attempt link, creator Session, exact action fingerprint and expiry, subject to the current Task and runtime authority ceilings |

Channel surfaces include the normalized account, chat, topic and applicable per-user isolation policy. A channel grant cannot authorize a local action or another account, topic, workspace or profile.

Reusable grants currently require equal verified host authority. EstaCoda does not infer nested-directory grants or an ordering between hypothetical backends. A matching grant can cover different arguments within the reviewed normalized target, such as subsequent writes to the same file. One-time approval additionally binds the arguments themselves.

Action tokens are opaque. Argument fingerprints used to assign those tokens remain in process memory, rather than entering durable approval receipts. Pending local/channel actions expire after ten minutes and cannot be transferred to another process. Restarted work may need a fresh exact-action review. Persistent grants remain reusable when their authority still matches.

Task approvals use their existing durable ownership records, not local/channel persistent grants. The queue checks the linked Task hierarchy and current authority before resolution. Task dispatch rechecks the Attempt fence and approval, and consumes the approval before executing. Exact-action tokens are retained through pending approval expiry, including the configured Task approval lifetime (24 hours by default). Cache pressure cannot evict retained tokens: the bounded 1,000-entry cache rejects new identities when every slot is retained, and capacity becomes available as retention expires or a Task approval is consumed or denied. Approval consumption still prevents replay; retaining an identity does not authorize another execution. A changed action or lost process-local action identity requires a new review; a durable queue decision alone does not authorize execution.

## Renewal and revocation

Use `/approvals` in an interactive CLI or channel Session to inspect grants. Legacy unscoped grants remain visible but inactive. Repeat the intended action and choose Session or persistent approval at its normal review boundary; matching subsequent work can reuse that scoped grant. Channels support `/approve session` and `/approve always`. Use `/revoke <approval-id>` to remove a persistent grant.

An old command queue entry without a valid execution binding cannot be approved. Repeat the request in its owning Session. Legacy Task queue entries are different: they can use an existing, validated Task approval link with its exact creator/Task/Attempt ownership. Missing or malformed ownership is never treated as permission.

Grant writes and revocations advance the storage revision. Revocation also advances a separate revision for the affected profile, surface, workspace, authority, tool, risk and target. Unrelated grants and revocations do not invalidate pending or assessed actions. Equivalent grant requests reuse the existing generation; changing a label does not rewrite authority. Immediately before dispatch, a previously allowed action must pass its current ownership and authorization checks. Revoking and recreating an identical grant cannot revive the old dispatch authorization. A relevant concurrent revocation can require one fresh review. A stale CLI-approved channel action is removed from the live pending continuations with one renewal message, allowing other chats to continue.

ACP's editor permission response authorizes only the offered one-time action. Changed arguments, expired context, another Session, and an unoffered permission option cannot reuse that response.

## Persistence and upgrade

Workspace grants remain in the existing global `workspace-approvals.json`. The supervised gateway keeps its existing profile-local `gateway/channel-approvals.json`; explicitly configured store paths are preserved. The JSON format is version 3 with a monotonic storage revision and scoped revocation records that survive grant removal. Version 2 scoped grants retain their authority; version 1 grants remain inspectable but do not gain an execution scope during migration. Old pending receipts may require renewal after upgrade. Unknown formats and malformed revocation records fail closed.

A sibling `.lock.sqlite` file serializes JSON mutations across processes. JSON remains the grant source of truth. SQLite transactions release on owner death; there is no age-based lock stealing. Writes use an atomic rename and private file permissions. Unknown formats fail closed. Mutations reject store and lock symlinks.

The existing Session database and queue payload hold pending bindings. No second grant database or authorization service is introduced. Stop all processes before taking a consistent backup of approval JSON, global Session state and profile workspace state. Do not run an older binary against upgraded approval stores: an old writer can discard scope/revision fields. Downgrade requires a compatible stopped-process snapshot.

## Limits

PR 3 and PR 4 add owned host resources, credential filtering, fenced Session execution and cancellation after live authority revocation; see [runtime ownership and its limits](runtime-ownership.md). These checks cannot undo an external operation already dispatched or provide OS containment. Docker adds verified per-container controls and distinct approval fingerprints; writable binds retain host-equivalent workspace mutation risk. Managed worktrees remain later work. This release is not evidence of multi-tenant isolation.

The tests use temporary local state, synthetic providers, separate Node processes and real SQLite/JSON persistence. They verify scope separation, one-time argument binding, reuse, legacy renewal, concurrent writes, owner death and revoke/regrant fencing. They do not establish production latency, live-provider cost or remote-environment isolation.

## Recurring channel work

A channel-origin cron runtime can reuse the originating surface's persistent grant across new execution Sessions when the workspace, host authority and reviewed action scope still match. Origin attribution comes from the authenticated gateway; tool arguments cannot supply it. Current channel authorization, workspace trust and target validity are rechecked before execution, during active authority validation and before delivery.

The origin also restricts cron job management, upstream-output context and jobs created by a scheduled agent. Other surfaces cannot inspect or revoke a scoped grant merely by sharing a chat ID. Legacy jobs and unscoped grants are not automatically adopted. See [cron authority and migration](../subsystems/cron.md#channel-origin-recurring-authority).

## Docker authority

Docker fingerprints include the verified image, user, workspace access, networking and resource limits. A host grant, another image or a different bind/network policy cannot supply equivalent Docker authority. Pending decisions also bind to the live environment instance. CLI, ACP, gateway and channel-origin recurring work preserve these actual facts. A restarted Docker environment requires renewed pending approval; an equivalent persistent scoped grant can still match after current verification. Admission blocks unsupported host tools before execution, including nested code-tool calls, regardless of an allowing security policy. Changing profile execution policy invalidates live authority and runtime caches.
