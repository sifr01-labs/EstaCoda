# Host execution and lifecycle

PR 3 supplies the host execution lease used by the core runtime. It runs on the operator's machine and does not provide filesystem, network, or operating-system containment. Workspace trust, command approvals and the hardline floor still apply. PR 4 adds [exclusive cross-process Session ownership and shared control](runtime-ownership.md). PR 6 adds [optional Docker execution](docker-execution.md) without making it a requirement for Local host.

## Ownership and execution view

An environment describes a verified workspace view. Each Session or child execution has its own resource scope. Borrowing an existing scope increments its reference count; creating a child scope shares the environment while giving that child independent process records, protected-input destinations and cleanup. Releasing one borrower does not release other borrowers. Releasing the last borrower cancels that scope and settles its owned resources.

The root runtime may retire while independently leased children remain active. Shared provider, connector and storage cleanup waits until those scopes finish. Construction and child Session persistence failures unwind acquired resources. Cleanup attempts all registered actions and reports failures. An uncertain process termination is not reported as successful cleanup.

The selected view supplies:

- File reads, writes, transactional patches, search, glob traversal and ripgrep execution.
- Read-only terminal inspection and ordinary shell commands.
- Background process management and the `execute_code` harness.
- Notebook edits, document/Python probe workers, project-context loading and explicit context references.

A runtime with a selected lease does not fall back to a caller-supplied workspace or an unrelated host filesystem for these operations. Standalone tool constructors retain a host implementation for local callers and tests. Glob's fallback when ripgrep is missing traverses the selected files backend.

Managed capability state is a separate boundary: profile/global configuration, credentials, memory, package installation, browser services, media caches, artifact retention and network integrations keep their existing gates. Document probes may read explicitly configured profile channel-media roots. Those roots do not become workspace roots. The Docker backend blocks unadapted model-visible host capabilities and rejects document roots outside its workspace; see its [capability boundary](docker-execution.md#what-runs-inside-docker).

## Editor content and disk

ACP editor content is an observation, not an executable filesystem overlay. File reads report `contentSource` and `materialized`. Referenced editor files supplied in ACP prompts are tracked through the same view. Line ranges are applied once to the full editor response.

Before shell, inspection, search, notebook or worker execution, the runtime rechecks observed editor files against disk. A mismatch or unavailable editor response blocks the operation with a save/reload message. Save the buffer to execute its contents, or reload it to use the current disk contents. The runtime does not silently save an unsaved buffer.

ACP explicitly selects materialized disk writes because its adapter currently reads editor buffers but does not implement editor write RPCs. Such writes require editor/disk parity first. Multi-file patches check parity before applying the transaction and retain rollback behavior. An arbitrary read-only adapter without this explicit mode cannot fall back to disk writes. Editors can retain stale content after a disk write; save/reload parity must be restored before subsequent dependent execution.

Only files actually observed by the runtime are checked; this is not an inventory of every open editor buffer. Observations are bounded to 128 paths per environment. Unsaved buffers and live processes are not implicitly transferable to another execution host.

## Child environments and configured capabilities

Ordinary commands and background processes no longer inherit the entire parent environment. They receive the existing runtime allowlist (executable path, locale, terminal/platform and temporary-directory settings), an isolated temporary `HOME`, and intentional adapter values. Owned temporary homes are removed after their processes settle. The harness additionally receives bounded input and allowed-tool metadata.

Trusted runtime callers can provide `executionControls.childProcessEnv.extra` for intentional capability configuration. Values come from the configured runtime adapter, never ordinary tool input. The legacy `mode: "inherit"` spelling remains accepted for callers but now uses the isolated environment behavior. Explicit `homeDir` overrides remain caller-owned and are not deleted. Protected process environment/stdin delivery remains scoped to that process manager and suppresses sensitive output. Provider and configured MCP credentials continue through their existing selected-profile resolvers/configuration.

A command that previously relied on an incidental parent variable must use explicit configuration or the protected credential flow. Isolating environment variables does not prevent an approved host command from reading files that its OS user can access.

## Bounds and cancellation

| Surface | Enforced bound / behavior |
|---|---|
| Workspace file reads | Regular files, at most 8 MiB; reject larger/changing reads rather than allocating arbitrary content |
| Directory enumeration | At most 20,000 entries per directory |
| Shell output | At most 16,000 retained characters per stream; result at most 16,000 characters, with truncation metadata |
| Inspection | Existing argv allowlist, 10-second maximum and bounded line/character collectors |
| Background processes | At most 128 retained/live records; each log capped at 96,000 characters and 1,024 entries |
| `execute_code` | Code at most 256 KiB; input and each bridge frame/result at most 64 KiB; at most 64 nested calls, one in flight; timeout 1–30,000 ms; retained output bounded by the requested 1,000–48,000-character limit |
| Probe workers | 64 KiB requests, 65,536-character responses, 4,000-character stderr, timeout at most 30 seconds |
| Glob / grep | Bounded subprocess output and cancellation; glob limits directory traversal to 20,000 directories and ripgrep listings to 20,000 files / 2,097,152 characters; grep bounds partial output frames and existing result pagination |

Complete harness protocol frames are parsed incrementally. Malformed, duplicate, concurrent or oversized requests stop execution. Nested calls still pass through the existing tool executor and approval path. Caller cancellation and scope release propagate to foreground execution. Long-running background processes remain owned by their scope until stopped or released.

POSIX processes start in owned process groups. Stop sends `SIGTERM`, allows one second, then escalates to `SIGKILL`; immediate cancellation can request `SIGKILL` directly. Leader exit also triggers group cleanup so descendants cannot keep output pipes open indefinitely. Settlement waits are bounded. After a failed POSIX group signal, cleanup polls for up to one second for OS proof that the group is absent. A live group or a denied probe retains ownership and reports failure. Later cleanup attempts can retry that proof; they do not signal a closed leader’s stale PID. Windows uses bounded `taskkill /T /F` for explicit termination.

## Limits and operational risk

These are local operator safeguards. They do not contain hostile code, a same-user attacker, or a descendant that deliberately escapes its process group. Windows process-tree behavior has not been validated by this PR's macOS test run; a process whose leader already exited cannot be assumed recoverable through `taskkill`. No multi-tenant or complete Windows descendant-containment guarantee is made.

Cancellation cannot recall a request already sent to an external service. A nested tool that ignores its abort signal may still have an uncertain side effect; verify the result before retrying. Cleanup failures can retain resources or harness temporary state for inspection instead of claiming settlement and deleting files still in use.

Filesystem containment/symlink checks protect structured workspace operations under the local trusted-operator model. They do not provide an atomic defense against hostile concurrent filesystem replacement. Host shell commands remain governed host commands with OS-user permissions.

PR 4 remains necessary for persisted exclusive Session ownership, fences, shared control transport, live authority revocation and runtime-cache acquisition races. Environment/scope IDs introduced here are not authorization tokens or substitutes for those controls.

## Script-backed cron and cancellation settlement

Script-backed cron runs, including `noAgent` runs, acquire an established Session target, persisted execution owner and selected execution lease without constructing a provider runtime. The runner requires an explicit selected-profile `scriptExecution` context and current workspace trust. Script processes use the lease's isolated environment, bounded output and process-tree termination. Trusted scheduler adapters can supply intentional configuration through `scriptExecution.childProcessEnv.extra`; scripts no longer inherit the supervisor's full environment. The CLI and supervisor supply their selected profile/state context.

A timed-out or cancelled Python harness retains its scope until accepted nested calls settle. The Session owner also tracks actual tool promises when the caller stops awaiting an aborted operation. A non-cooperative operation may therefore keep disposal and handoff pending; cancellation is not reported as proof of successful cleanup.
