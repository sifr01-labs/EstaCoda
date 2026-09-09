# Workspace and execution implementation plan

Status: proposed implementation plan. This document describes future work, not shipped behavior. It replaces the earlier workspace/Docker roadmap for this workstream.

Shared contract and ownership decisions are defined in [Shared workspace, target, and execution ownership decisions](workspace-execution-ownership-decisions.md). That document is authoritative for overlap with the Desktop plan: core target bindings, supervisor ownership, private control transport, handoff, and recovery. It is also proposed work, not a shipped guarantee.

## 1. Product objective

Make EstaCoda reliable across CLI, ACP, channels, Tasks, cron, and delegation while minimizing interruptions and preserving existing operator choices.

The operating rule is:

> Execute autonomously within established authority. Ask when the required action exceeds it. Keep actions, outcomes, and recovery inspectable.

The ordinary local workflow remains:

```bash
cd my-project
estacoda
```

Docker and named workspaces are optional. A configured, authenticated channel or scheduled job may operate on an authorized host workspace without installing Docker. A user can authorize sandbox changes to be applied during the initial task request; an additional review is needed only when the proposed application exceeds that authority or encounters a conflict.

Success means more completed tasks, fewer unnecessary approvals, predictable recovery, and no unauthorized expansion of execution authority. Architecture breadth is secondary.

## 2. Rules for minimal friction

1. Preserve the existing `strict`, `adaptive`, and `open` modes. Keep adaptive as the normal default. Do not silently reinterpret strict mode or weaken the hardline floor.
2. Reuse existing workspace/session grants. Extend their validation and scope instead of introducing a competing authorization subsystem.
3. Permission for an ordinary task includes its necessary, reversible steps within the existing policy and selected workspace. A request to edit code does not authorize publishing, arbitrary credential access, unrestricted destruction, or spending.
4. Let operators explicitly authorize recurring work for a workspace and authenticated surface. Do not ask for the same authority on every run.
5. Keep configured capabilities discoverable even when execution requires authorization or setup. Explain the missing authority and provide the existing apply/approval path.
6. A selected sandbox may fail to provision. Report the cause and offer an explicit alternative; never execute on the host merely because preparation failed.
7. Separate child ownership and cancellation from physical isolation. Children may share an explicitly selected workspace or environment when their authority is compatible.
8. Apply sandbox changes automatically when prior authorization covers the task, destination, and mutation type, and the destination has not changed incompatibly.
9. Configuration and definition changes cause only the necessary rebuild or revalidation. Harmless changes do not require renewed approval.
10. Introduce interfaces with a live consumer. Use functions and existing stores where sufficient; do not create a service class for every architectural concept.

## 3. Product choices and defaults

| Surface or workflow | Initial behavior | Operator choice |
|---|---|---|
| Interactive CLI | Current-directory host execution under the selected security mode, without a required daemon | Named workspace, an existing worktree directory, managed worktrees when implemented, or Docker |
| ACP/editor | Host execution with explicit editor-buffer semantics | Supported sandbox mode when configured |
| Existing gateway/channel installation | Preserve its configured backend and existing authorization checks | Change backend through reviewed configuration |
| New channel setup | Select the workspace and execution mode within the existing setup/apply flow | Authorized host or available Docker; no mandatory Docker dependency |
| Tasks and cron | Use the execution policy explicitly attached to the job or its authorized origin | Host, shared environment, or separate environment |
| Delegation | New child ownership scope, same or narrower authority | Share compatible resources or request stronger separation |
| Docker coding | Writable bind mount when that mode is explicitly selected | Read-only mount or temporary copy |
| Temporary-copy work | Apply within the authorized change scope after checks | Export/review-only when requested or required |

Migration preserves existing behavior only within existing authority. Prior activity, a backend label, or an old unscoped approval is not evidence for a new authorization grant.

Expose **Local** and **Sandboxed** when implemented. Add **Remote** only with a working, supported backend. Keep technical settings in the Setup Editor, and preserve the existing first-run wizard sequence.

## 4. Architecture and ownership

The coordinator is shared core code, not a new always-running service. The existing profile-bound supervisor owns shared interactive work, Tasks, cron, and channels; foreground CLI/ACP can execute locally under the same persisted session ownership rules. Desktop connects through a client bridge and cannot create a competing executor for an already-owned session. See the shared decisions for the process topology and lifecycle matrix.

```text
CLI / ACP / ChannelGateway / Task / Cron / Delegation
                         |
                         v
Runtime coordinator
  selected profile + source/target binding + fenced session ownership
  live trust + current policy + definition revision
                         |
                         v
Prepared execution environment lease
  verified execution facts + workspace operations
  command runner + process ownership + artifact transfer
                         |
                         v
Existing tool executor and security/approval paths
```

### Workspace identity

Extract the existing Task workspace contract without changing its persisted fields:

```ts
type WorkspaceIdentity = {
  canonicalPath: string;
  identityHash: string;
};

type TaskWorkspaceBinding = WorkspaceIdentity;
```

A profile-local registry adds a stable generated workspace ID, mutable alias, and location revision. Shared core target records identify the actual working directory independently of that source selection. `TaskWorkspaceBinding` retains its existing meaning: the actual execution root, including a worktree/copy root, never merely its source repository. Host versus Docker is environment policy, not target kind. The environment owns its internal execution filesystem handle; container paths never replace legacy host workspace identities.

Use the shared `SourceWorkspaceBinding` and `ExecutionTargetBinding` semantics from the [contract decision](workspace-execution-ownership-decisions.md#2-shared-workspace-and-target-contracts). Ordinary launches may create/reuse a local target record automatically without requiring a named registry entry or additional approval. Desktop consumes the same records. Source moves do not rewrite existing Session/Task bindings; target replacement requires a new target and an explicitly supported fork/recovery flow.

- Renaming an alias preserves bindings.
- Changing a root changes its authorization identity. Do not transfer sessions, grants, or artifacts automatically.
- Resolve trust for the destination under existing global trust semantics. Do not grant it through registry mutation or globally revoke an independently trusted destination.
- Prevent existing channel bindings from silently following a moved workspace into a new authorization identity. Rebind through an authorized operator action.
- Current-directory launches require no registry entry.
- Preserve UUID session identities and current fresh/resume behavior. Workspace scoping is an ownership rule, not a reason to reuse a previous session automatically.

### Execution context and scope

Execution context carries profile, workspace, session, initiating surface, and optional Task/attempt/parent identifiers. Trust and verified containment are resolved live.

A scope owns process handles, cancellation, artifacts, and optional shell state. An environment may serve several compatible scopes. Shared environments must not expose broader credentials, mounts, or networking to a narrower child; allocate a separate environment when that separation cannot be enforced.

Shared writable workspaces need explicit conflict handling. Use existing task coordination or separately selected worktree directories where possible. Managed Git worktree creation/cleanup is new core work delivered by the Desktop worktree slice; it is not an existing runtime manager or a prerequisite for host execution. Sharing does not imply approval for cross-session process control or destructive cleanup.

### Requested policy and verified facts

Requested policy records the chosen backend, workspace access, network policy, credential capability references, lifetime, and resource limits. Mark requirements as mandatory or advisory where the distinction has a real consumer.

Verified facts record what the selected environment actually enforces:

- Execution target and environment instance identity.
- Workspace handle, source identity, and effective mounts/access.
- Isolation and host-control capabilities; multiple capabilities may coexist.
- Command-network policy and its version, including allowed destinations where applicable.
- Credential capability identifiers/scopes and their policy revisions, never credential values or secret-derived fingerprints.
- Effective CPU, memory, PID, output, and time limits, including unsupported or unverified values.
- Lifetime and persistence authority.
- Verification generation, freshness, and actionable degradation reasons.

Missing mandatory controls block that requested execution mode. Unsupported advisory controls are reported without repeatedly prompting. Requested and degraded behavior must remain within existing authority.

A sanitized host environment is not filesystem or network containment. Report host execution honestly. Worktrees provide change separation, not security isolation.

### One lease for execution

Files, search, inspection, commands, processes, and `execute_code` use components from the same prepared lease. Keep profile state and runtime management operations outside the workspace backend only through explicit, separately governed paths.

`release()` detaches a borrower. Destruction is separate. The manager destroys only resources it owns, after their lifetime ends and no valid borrower remains.

For ACP, distinguish unsaved editor content from materialized execution content. If a command depends on an unsaved edit, use an editor-supported authorized save/materialization path or report the mismatch. Do not silently overwrite buffers or promise shell visibility from a read overlay alone.

### Runtime, authority, and definition identities

Keep these purposes separate:

- **Runtime build key:** construction-relevant configuration, selected profile/workspace, model routes, tools, skills, MCP/browser configuration, relevant definition revision, trust generation, and environment configuration.
- **Authority fingerprint:** normalized authority-relevant facts and policy revisions. Include actual credential/network scopes and environment identity when grants depend on them. Exclude verification timestamps and UI metadata.
- **Definition revision:** a bounded manifest of instruction/skill/tool-policy/model-route/Evolution revisions needed to explain and resume the run. Store identifiers and hashes of non-secret definition content; do not duplicate secrets or bulk memory in the manifest.

Target generations, execution-owner fences, and authorization generations remain separate. A target health timestamp or alias edit must not invalidate reusable grants. A runtime cache entry never grants session ownership. Cross-process session claims, Task lease ordering, renewal failure, and recovery follow the [shared ownership protocol](workspace-execution-ownership-decisions.md#4-session-ownership-dispatch-and-handoff).

The definition manifest extends existing profile, skill, trajectory, and Evolution machinery. It is not a second editable agent configuration system.

## 5. Approval and revocation behavior

Extend the existing stores/controllers with only the additional scope needed by their consumers.

| Approval type | Validation |
|---|---|
| One pending action | Bind profile, session/Task, authenticated surface where applicable, workspace identity, exact action/target, relevant authority, expiry, and authorization generation |
| Session or Task grant | Reuse for covered operations within that session/Task and its explicitly permitted child scopes |
| Persistent grant | Reuse within explicitly approved workspace, surface, action/target, and authority limits; provide inspect/revoke controls |
| Managed capability installation | Retain existing profile/capability-specific validation; do not treat it as a generic command grant |
| Sandbox import | Cover task/source provenance, target workspace, selected paths or change scope, allowed mutation types, and expiry/lifetime |

Pending action approvals remain conservative about environment substitution. Reusable grants may cover equal or narrower authority only through an explicit deterministic comparison. If containment cannot be compared safely, revalidate rather than guess. For example, switching from a copy to a host mount is not an equivalent grant.

Hardline checks run before grants and at final execution. New external recipients, spending, broader credentials, trust changes, or destinations outside the grant need the applicable authorization.

On revocation:

1. Advance the relevant authorization generation so old approvals cannot revive after regrant.
2. Fence new dispatches immediately and revalidate queued work and resumptions.
3. Signal cancellation to affected active operations and terminate owned command/process trees where supported.
4. Retire affected cached leases; reference-counted cache eviction alone is insufficient.
5. Preserve recovery evidence. An already completed external side effect cannot be undone by revocation; an interrupted mutation with unknown outcome requires verification before retry.

Serialize acquisition and authority transitions sufficiently to avoid duplicate environments, stale dispatches, and competing cleanup. Revalidate immediately before side effects; clearly document cancellation limits for external operations.

## 6. Network, credentials, and host-side tools

- Keep model/provider credentials in the runtime control process.
- Use the existing sanitized child-environment helper as the starting point. Support explicitly configured environment/credential needs without copying the full parent environment into background or delegated work.
- Keep host compatibility visible: isolated HOME/environment may affect Git configuration, package tools, and authentication. Provide narrow operator configuration and migration guidance in the PR that changes behavior.
- Docker initially supports enforced network-none and explicitly authorized direct networking. No proxy is required for the first release.
- Host execution reports its actual host-network authority; a config value cannot establish network-none on an unrestricted host process.
- Browser, MCP, messaging, and other host-side tools remain independently gated. A container with no network may still request an authorized network tool through the runtime, so UI and approvals must distinguish command networking from tool-mediated networking.
- `execute_code` tool requests inherit the current authenticated context, grants, budgets, and cancellation; they cannot become an unrestricted host RPC channel.
- Inventory exposed host-side tools before sandbox release. Workspace operations must use the lease; management tools retain their own explicit policy. Unsupported execution paths remain discoverable with an actionable explanation and cannot silently run on the host.

## 7. Delivery and commit structure

PRs are independently usable. Tests and documentation accompany the behavior they cover. Setup, migration, and safety prerequisites ship with the feature that needs them.

### PR 0 — Baseline and implementation boundaries

Branch: `ame/execution-baseline`

Commits:

1. `docs(execution): record minimal-friction rollout and authorization rules`
2. `test(execution): characterize current workspace session and approval behavior`
3. `test(runtime): establish host completion latency and interruption baselines`

Inventory all host execution/file/network paths, including `execute_code`, process tools, ACP, MCP tool dispatch, project-context loading, and delegated/cron runtimes. Map checkpoint, operation journal, trajectory, and Task stores to their new consumers.

Characterize concurrent cache acquisition, supervisor singleton/lock expiry, and CLI/shared-host session ownership. Record the shared decisions before implementing separate Desktop target or ownership code.

Record the revision and dependency/runtime versions. Run in a clean isolated checkout without deleting the existing untracked user files. Measure ordinary code-edit, channel, scheduled-work, and interrupted-task workflows before setting reviewed regression budgets. Include provider calls/tokens and approval frequency, not just startup latency.

Acceptance: current behavior and scope are documented; known failures are distinguished from future requirements; no execution authority changes.

### PR 1 — Stable workspaces and session ownership

Branch: `ame/stable-named-workspaces`

Commits:

1. `refactor(workspaces): extract compatible workspace identity contract`
2. `feat(workspaces): add profile-local registry with stable ids and aliases`
3. `feat(execution-targets): add core local targets and immutable session task bindings`
4. `feat(cli): add workspace commands and prefix-only selection`
5. `fix(session): enforce profile and workspace ownership on construction attach and resume`
6. `test(workspaces): cover moves aliases legacy sessions and concurrent updates`
7. `docs(workspaces): document selection trust and migration behavior`

Commands: `workspace add`, `list`, `show`, `rename`, `move`, `remove`, and `open`; prefix-only `estacoda --workspace <alias>`. Preserve benchmark `--workspace <path>` parsing.

Use atomic updates with concurrency control, validate existing directories and aliases, and keep registry mutation separate from trust. Never adopt ambiguous legacy remote sessions. Allow bounded local legacy binding only when ownership can be established through the existing authorized local flow.

Deliver the core local target record and immutable Session/Task binding here, preserving existing execution-root compatibility fields. Define migration and common runtime-construction validation once. The Desktop execution-target milestone consumes this work and adds managed Git worktree behavior; it must not introduce a second target registry or repeat ownership migrations.

Acceptance: normal launch behavior is unchanged; aliases work; renames preserve identity; moves cannot silently transfer authorization; cross-profile/workspace attachments fail.

### PR 2 — Verified authority and reusable approvals

Branch: `ame/scoped-execution-authority`

Commits:

1. `feat(execution): define requested policy and verified host facts`
2. `fix(security): remove environment-label containment privileges`
3. `feat(approvals): extend existing grants with execution scope and revisions`
4. `fix(approvals): validate pending actions and reusable authority separately`
5. `fix(security): fence stale approvals across revoke and regrant`
6. `test(security): cover grant reuse expansion denial and legacy migration`
7. `docs(security): document approval reuse and current authority checks`

Retain `EnvironmentType` only where compatibility needs it; it cannot grant containment privileges. Verified host facts are produced by trusted runtime code and cannot come from model-visible input.

Preserve covered approvals across equivalent operations. Unknown/missing legacy binding fields never become wildcard authority. Show one actionable renewal path for affected approvals rather than repeatedly asking per tool call.

Acceptance: covered work proceeds without repeated approval; expansion is gated; hardline behavior remains non-overridable; metadata-only changes do not churn grants.

### PR 3 — Complete host execution lease

Branch: `ame/host-environment-lease`

Commits:

1. `feat(execution): add ownership scopes and host environment leases`
2. `refactor(files): route workspace operations and inspection through host backend`
3. `refactor(process): scope command and background process ownership`
4. `refactor(execute-code): launch harness through the host lease`
5. `security(process): isolate child environments with explicit configuration`
6. `fix(execution): bound streaming output and propagate cancellation`
7. `fix(runtime): release leases and terminate owned ephemeral processes`
8. `test(execution): cover host parity editor content and shared child scopes`
9. `docs(execution): document host compatibility and lifecycle behavior`

Workspace operations cover existing reads/writes/patches/search/inspection plus only the new operations required by current consumers. Enforce containment and symlink policy consistently; preserve transactional patch behavior.

Handle spawn errors, aborts, timeout escalation, output floods, and descendants. Bound harness input, tool-call counts, payloads, output, and time. Separate child process/shell ownership even when an environment is shared. Keep existing authorized capability configuration usable through explicit adapters.

Acceptance: files, shell, background processes, and Python harness share the selected execution view; no silent host escape path remains to be inherited by Docker; routine host workflows remain usable.

### PR 4 — Runtime coordinator, live trust, and compatible recovery

Branch: `ame/runtime-coordinator`

Commits:

1. `feat(runtime): coordinate context configuration ownership and environment acquisition`
2. `feat(runtime): distinguish build authority and definition revisions`
3. `feat(session): add cross-process execution ownership and fenced transitions`
4. `refactor(runtime): migrate CLI ACP Tasks cron and delegation acquisition`
5. `fix(gateway): harden supervisor singleton and instance ownership`
6. `feat(gateway): host shared sessions through authenticated private control IPC`
7. `feat(control): persist accepted operation receipts and prioritize cancel approval commands`
8. `fix(gateway): acquire current configuration and live workspace trust`
9. `fix(cache): serialize acquisition and validate leased environment health`
10. `fix(runtime): fence active execution after authorization revocation`
11. `feat(checkpoints): bind recovery to workspace definition and authority`
12. `test(runtime): cover cross-surface ownership revocation and compatible resume`
13. `docs(runtime): document acquisition migration and recovery limits`

Extend the existing runtime factory/cache and checkpoint infrastructure. Preserve the selected profile and existing provider resolver; do not merge project config. Preserve the gateway's approval orchestration ownership.

This slice also delivers the [shared process ownership decision](workspace-execution-ownership-decisions.md#3-process-topology-and-private-control-transport): persisted session claims/fences; Task host/attempt/session lease ordering; hardened supervisor singleton acquisition; shared interactive-session hosting; and an authenticated private local endpoint with minimal send/cancel/approval methods and durable operation receipts. Foreground CLI/ACP remain daemon-free and participate in the same ownership checks. Desktop's bridge is a client, never another Task scheduler or channel poller. Split this slice into smaller implementation PRs as needed; the complete ownership gate precedes real Desktop Work execution.

Definition changes are classified: metadata-only changes need no interruption; construction changes rebuild safely; changed instruction/tool behavior is recorded and applied at supported boundaries; security changes require live validation. Resume with current governance even when retaining historical definition provenance.

Use existing persisted operation states to avoid blind mutation replay. A dispatched/uncertain side effect must be verified or reconciled, or require intervention if that is impossible. Do not promise general exactly-once execution.

Acceptance: configuration and trust changes need no gateway restart; MCP exposure is rebuilt when appropriate; active revocation is effective beyond cache eviction; harmless changes do not need new approval; existing checkpoints remain readable under explicit migration rules. Concurrent clients cannot create competing owners for one session; cache acquisition does not leak duplicate runtimes; TTL/socket failure alone cannot authorize live-owner takeover; accepted controls survive response loss without blind mutation replay.

### PR 5 — Channel workspace selection and recurring authority

Branch: `ame/channel-workspace-selection`

Commits:

1. `feat(channels): persist profile-local workspace and surface bindings`
2. `feat(channels): add alias-based workspace selection`
3. `fix(channels): validate switch handoff and continuation ownership`
4. `feat(gateway): reuse scoped operator grants across recurring work`
5. `fix(gateway): bind approval resume and migration to current authority`
6. `test(channels): cover switching active work restart and persistent grants`
7. `docs(channels): document host sandbox and recurring-work choices`

Commands: `/workspace`, `/workspace list`, `/workspace use <alias>`. Remote commands accept registered aliases, not arbitrary local paths. Authorization remains tied to authenticated channel/session scope.

Changing the future workspace pointer never retargets active work. Permit switching only where the channel/session model safely separates future and running work; otherwise return an actionable busy response. Stop/approve/deny must remain reachable.

Channel attach joins the existing supervisor session owner. Foreground CLI/ACP transfer occurs only at a settled, checked boundary; live shells, provider streams, or unsaved buffers are not implicitly migrated. Desktop-originated decisions on channel approvals route through a local operator method owned by `ChannelGateway`, including its continuation/delivery handling. Do not resolve queue rows from Desktop or impersonate a channel sender.

New channels choose execution authority through the existing setup/apply flow. Existing configured host workflows are not disabled by adding Docker support. Update service installation metadata without silently following workspace moves.

Acceptance: an operator authorizes a recurring workflow once within a clear scope; subsequent runs reuse it; another chat/workspace cannot borrow it; background work is not dependent on Docker installation.

### PR 6 — Docker with complete execution parity

Branch: `ame/docker-environment-lease`

Commits:

1. `feat(execution): add optional Docker policy setup and capability probing`
2. `feat(execution): prepare owned Docker leases and verify effective controls`
3. `feat(files): implement Docker workspace operations for bind modes`
4. `feat(execution): add Docker commands processes and code harness transport`
5. `security(execution): enforce initial network and host-control policy`
6. `feat(execution): apply mandatory and advisory resource limits`
7. `fix(execution): cancel and clean only owned Docker resources`
8. `test(execution): require Docker parity containment and failure coverage`
9. `docs(execution): document sandbox setup authority and residual risks`

Ship read-only and read/write bind modes together with file, command, process, and `execute_code` support. Enforce network-none from this PR; direct networking is an explicit authorized option. The host-side tool boundary and approval checks also ship here.

Use controlled images and explicit provisioning ownership. Verify mounts, effective user, networking, privilege, capabilities/namespaces, resource limits, and ownership before execution. Sandboxed configurations reject Docker sockets, privileged mode, unsafe host mounts, host namespaces, and devices. Writable host mounts retain host-equivalent risk for the mounted workspace.

Image acquisition and backend setup are visible operator actions through existing setup/capability flows. Creating another environment from the approved configuration should not prompt again unless it expands authority or spending.

Acceptance: shell/file/code parity is proven; required controls fail closed; no sandbox-to-host fallback exists; configured host operation remains independent; Docker tests cannot all skip on the Docker release gate.

### PR 7 — Temporary copies and authorized change application

Branch: `ame/sandbox-change-application`

Commits:

1. `feat(workspaces): prepare bounded temporary copies with source manifests`
2. `feat(artifacts): export changes with source ownership and baseline hashes`
3. `feat(approvals): record scoped change-application authorization`
4. `feat(workspaces): apply covered changes after conflict and containment checks`
5. `fix(workspaces): preserve transactional recovery for interrupted application`
6. `test(workspaces): cover preauthorized imports conflicts and malicious artifacts`
7. `docs(workflows): document automatic application and review-only modes`

Offer two outcomes: apply covered changes, or export for review. Use task-start authorization when it already covers application; do not manufacture a second approval ceremony.

Create copies from an explicit source manifest. Do not blindly copy ignored secrets, runtime state, special files, or credential directories. Handle tracked content, selected untracked inputs, dependencies, binary files, modes, and deletion semantics explicitly.

Before application, verify artifact/source provenance, destination identity and trust, selected paths/mutation types, baseline hashes, symlink containment, and current grants. Conflicts preserve local edits and produce a reviewable result. Deletes or other destructive operations still follow existing policy.

Journal application progress and support recovery. Rollback restores only files that still match the applied result; it never overwrites later user edits. Do not promise universal undo for external side effects.

Acceptance: authorized coding work can finish end to end without another approval; review-only requests remain review-only; conflicts or expanded scope are surfaced; copies never synchronize implicitly.

### PR 8 — Release usability, diagnostics, and conformance

Branch: `ame/execution-release-hardening`

Commits:

1. `feat(doctor): explain effective execution authority and actionable blockers`
2. `feat(ui): summarize execution changes and approval scope in plain language`
3. `feat(diagnostics): record bounded performance completion and friction counters`
4. `test(execution): complete host Docker and cross-surface release matrix`
5. `test(security): stress authority races cancellation leaks and artifact boundaries`
6. `smoke(execution): add required backend lifecycle validation`
7. `docs(execution): publish implemented workflows migration and threat model`

Earlier PRs include the configuration paths and diagnostics needed to use them; this PR consolidates and verifies the experience. Preserve Arabic/bidirectional rendering and keep private paths off remote summaries.

Extend existing trajectory/checkpoint records with definition/authority references and bounded metrics. Use representative existing evaluations to compare task completion and regression budgets. Full automatic production-trace conversion into eval fixtures is follow-on work.

Acceptance: the first host-and-Docker release passes the release gates below. No Remote option or unsupported containment claim appears in public UX.

## 8. Follow-on increments

These are outside the first release. They do not delay PRs 1–8, and no dependent feature is exposed before its controls exist.

### PR 9 — Persistent environments and longer-lived shell state

Branch: `ame/persistent-environment-lifecycle`

Commit groups: profile-local ownership metadata; persistent workspace volumes; explicitly selected shell persistence; reconnect/health validation; environment list/inspect/cleanup; crash and multi-day recovery tests; operations guide.

Reuse existing Task/checkpoint state. Add lease fencing and recovery references there rather than creating parallel Run/Step databases. Persist no credentials in metadata or shell snapshots. Keep release, reconnect, and destructive cleanup separate. Reusing an environment after authority changes requires current verification.

### PR 10 — Scoped network and credential mediation

Branch: `ame/scoped-network-mediation`

Commit groups: reuse existing URL/egress policy and protected credential transports; add a scoped proxy only for a demonstrated consumer; enforce destination/method/redirect/private-address/metadata rules; bound traffic; add capability-based credential substitution; adversarial tests and documentation.

Keep network-none and authorized direct networking usable. The proxy adds a narrower option. Credentials remain destination/capability-bound, short-lived where supported, and absent from logs/snapshots.

### PR 11 — Trace-to-evaluation workflow

Branch: `ame/execution-evaluation-feedback`

Commit groups: export redacted reproducible cases from existing traces; bind cases to definition/tool revisions; run existing applicable eval gates; link evidence to Evolution proposals; test redaction and promotion gates; document review and retention.

Production observations may propose improvements. They never silently mutate live prompts, skills, security policy, or memory. Do not claim real fixture execution from metadata-only skill scoring.

### Remote backend extensions

Select one backend only after demonstrated demand and stable core operation. Each backend implements the same lease/file/code/process contracts, verifies its own controls, defines authentication/spend authority, and includes failure/cancellation/cleanup tests.

SSH is host-equivalent remote authority unless stronger isolation is independently enforced. Do not claim hostile multi-tenant isolation from the Docker implementation. A shared hostile-code hosting product needs a separately reviewed threat model and stronger isolation work.

## 9. State, memory, and migration

- Global trust, workspace approvals, and sessions remain in their established stores. Additional grant scope does not require moving those stores.
- Workspace registry, channel bindings, execution metadata, and non-global artifacts remain profile-local using existing profile-path helpers and stores.
- Workspace-specific memory and recall stay workspace-scoped. Profile memory remains intentionally available within the selected profile; explicitly shared memory retains its existing semantics. Prohibit unauthorized crossing rather than eliminating legitimate sharing.
- Reuse the existing artifact store and ownership checks instead of introducing duplicate artifact storage merely for Docker.
- Persist schema versions and clear migration behavior. Never silently upgrade unknown legacy ownership into authority.
- Each persistence PR specifies downgrade behavior. Where an older runtime cannot safely read new state, fail with recovery instructions rather than dropping security fields or accepting a partially interpreted record.
- Keep checkpoints bounded and redacted. Definition/authority references do not authorize recovery by themselves.

## 10. Release gates

### Task completion and friction

- Ordinary local launch remains simple and requires no Docker or registry setup.
- Existing authorized host channel/Task workflows continue working.
- Covered recurring work reuses approval; no per-run reconfirmation.
- Harmless configuration changes do not trigger authority prompts.
- Authorized temporary-copy edits can be applied without extra review.
- Conflicts and authority expansion receive one clear, actionable intervention.
- Registered task-relevant capabilities remain discoverable.

### Runtime and recovery

- Every migrated surface agrees on profile/workspace ownership, current trust, backend selection, and relevant approval scope.
- All applicable cases in the [shared conformance matrix](workspace-execution-ownership-decisions.md#7-required-conformance-cases) pass, including simultaneous clients, foreground/shared ownership races, lost responses, sleep, stale owners, and target replacement.
- Files, commands, processes, and code harnesses use the selected environment.
- Active revocation fences dispatch and cancels owned work with documented external-operation limits.
- Cache replacement, concurrent acquisition, release, and destruction do not leak or kill another scope's resources.
- Crash recovery preserves uncertain mutations and avoids blind replay.
- ACP buffer and command views have explicit, tested semantics.

### Security

- Hardline rules remain non-overridable, including wrappers and nested tool calls.
- Approvals cannot cross unauthorized profile/workspace/surface/authority boundaries.
- Revoke/regrant does not revive invalidated approvals.
- Required sandbox controls are verified before execution.
- No unsupported path silently executes on the host.
- Secret/environment inheritance, malicious paths/artifacts, unsafe mounts, and host-tool mediation receive success and denial tests.
- Unknown containment does not become a permission grant.

### Measured quality

Compare against PR 0: completion rate, recovery success, provider calls/tokens, approval frequency, host startup/command latency, Docker cold/warm acquisition, and resource leaks. Set reviewed budgets after measurement. Explain regressions and fix material failures before release; do not invent numerical success claims.

## 11. Validation and review

For implementation PRs, run focused tests first, then the repository validation commands:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
git diff --check
```

Docker work also runs existing image validation plus a dedicated, required execution-backend integration job. The current `validate:docker` script checks package-image build/startup and can skip without Docker; it is not proof of sandbox containment. Add a non-skipping release gate for actual backend file/code/process/network/lifecycle behavior. Keep live billable tests separately authorized.

Each security-sensitive PR includes changed behavior, authorization impact, migration/downgrade behavior, focused risk notes, checks actually run, and remaining limitations. Preserve independent reviewability without requiring every internal preparatory commit to expose a new feature.

## 12. Definition of done for the first release

PRs 1–8 deliver optional named workspaces; immutable session ownership; reusable scoped approval; one host/Docker execution lease; live trust and revocation; consistent cross-surface runtime acquisition; complete initial backend parity; temporary copies with authorized application; compatible checkpoint recovery; and clear configuration/diagnostics.

Persistent volumes, advanced shell persistence, scoped egress proxies, automated trace-to-eval conversion, remote providers, and a new desktop application are not prerequisites. The existing desktop plan can consume these runtime contracts later; this workstream does not change its first-alpha scope.

The first implementation commitment is PRs 0–4 and their shared ownership gate, followed by a small packaged Desktop/local-work proof. PR 5 and the Telegram proof follow; PRs 6–8 complete the host-and-Docker release. Docker and temporary copies do not delay the small Desktop proof. Managed worktree lifecycle has one implementation owner in the Desktop worktree slice and remains optional here. This sequencing changes dependencies, not the completeness required for the eventual workspace release.

The release is complete when ordinary authorized work finishes with minimal interruption, changed authority is handled explicitly, and validation demonstrates that both properties hold.
