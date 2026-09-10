# Docker execution

PR 6 adds optional local Docker execution for the selected profile. Local host remains the default and requires no Docker installation. Both backends use the same workspace/target identity, Session ownership, trust, approvals, and hardline command floor.

## Setup and authority

Use the existing Setup Editor's execution-policy action in its security section. Choose Local or Sandboxed, then review the bind and network choices before applying. The Docker choice defaults to a read-only workspace and disabled command networking. Read/write access and direct networking are explicit operator choices. Setup probes availability without pulling images. If the controlled image is missing, the reviewed apply step builds it from the bundled Dockerfile and downloads its base images/packages. Cancellation before apply performs no image acquisition or configuration write. A failed apply may leave a built image; it does not authorize execution through a partial configuration.

Requirements are a local Docker Unix socket, Linux containers, cgroup v2, seccomp, and a workspace directory shared with the engine. TCP/SSH Docker endpoints and Windows named-pipe engines are unsupported. Docker Desktop or Colima must already be installed and running; EstaCoda does not install, start, or reconfigure the engine during acquisition. A missing engine, image or required control blocks Docker execution with no host fallback.

The selected profile's `config.json` stores `execution`, including the immutable image ID. Project configuration is not merged. Runtime acquisition uses the approved image with `--pull=never`; creating another lease does not download or upgrade it. Changing the selected policy invalidates live authority and cached runtimes. This does not change a Session's target directory. Settle active work before applying a new policy; stale pending approvals must be renewed.

For example, the stored policy shape is:

```json
{
  "execution": {
    "backend": "docker",
    "imageId": "sha256:<64 lowercase hexadecimal digits from setup>",
    "workspaceAccess": { "value": "read-only", "requirement": "mandatory" },
    "commandNetwork": { "value": "disabled", "requirement": "mandatory" },
    "limits": {
      "value": { "cpu": 1, "memoryBytes": 536870912, "pids": 128, "outputBytes": 4194304, "timeoutMs": 120000 },
      "requirement": "mandatory"
    }
  }
}
```

The image placeholder above is explanatory and cannot be used as a valid configuration. Resource limits are advanced config/programmatic controls; the Setup Editor currently exposes backend, bind mode, and networking. The programmatic Docker policy defaults to read/write when `workspaceAccess` is omitted; the interactive setup explicitly records its read-only default.

## What runs inside Docker

The lease routes workspace files, patches, search, grep/glob, notebooks, terminal commands and inspection, managed processes, Python/document probes, and `execute_code` through the container view. Shell execution uses the image's Bash; the image also supplies Python 3.12, Node 22, Zsh, Git, ripgrep, and standard inspection utilities. No arbitrary image selector or package-install tool is added. Scripts can run only interpreters/dependencies actually present in the approved image. Host Python environments and arbitrary credential injection are not imported.

The bind has the same absolute path inside the container, preserving existing tool and Task path contracts. It is the only workspace bind; the root filesystem is read-only, `/tmp` is a bounded tmpfs, and the process runs with a non-root UID, no capabilities, no-new-privileges and seccomp. Acquisition verifies image, ownership, mount mode/propagation, namespaces, networking, user and effective cgroup values. Host roots, profile state, trusted runtime code, socket/device/FIFO entries and unsafe bind paths are rejected. Structured file operations additionally reject traversal, sensitive paths and symlink escape.

Each command and structured file operation uses a separately owned short-lived container. This makes cancellation independent across commands and child scopes; it also adds creation, inspection and cleanup latency. File-heavy tasks can incur substantial overhead. Shell state and `/tmp` contents do not persist between commands; workspace writes do. This implementation favors verified ownership over throughput and is not a performance-qualified managed service.

The runtime, provider calls, configured connector startup, profile memory, scheduling, and messaging services remain host control-plane services. **Disabled command networking is not an offline-runtime guarantee.** Model-visible host tools remain discoverable but are blocked by the Docker admission boundary unless their built-in implementation was reviewed to use the lease or bounded runtime bookkeeping. This includes browser/web, MCP calls, configuration/install operations and host media/artifact tools. The blocker directs the operator to an explicitly authorized Local workflow. Direct Docker networking does not bypass this boundary. Nested `execute_code` tool calls pass through the same executor and approvals. Document tools cannot fall back to host channel-media directories; required inputs must already be in the selected workspace.

## Bind, network, and resource risks

A bind exposes the whole selected directory to arbitrary commands, including ignored files, `.git` and any secrets already stored there. Structured file-tool filtering does not hide those files from shell programs. Choose a project directory with appropriate contents. A read/write bind permits immediate host-file changes with host-equivalent risk within that directory; it has no implicit review, synchronization, rollback or deferred apply step. Read-only mode protects that bind from container writes, not from other host processes.

Network-none is enforced by Docker and tested with an attempted outbound connection. Direct networking uses the Docker bridge and reports no network containment. It permits destinations reachable from that engine, potentially including private services; it is not a domain allowlist, spend limit or egress proxy. Existing tool approvals and non-overridable hardline checks remain active in both modes.

| Control | Default / supported range |
|---|---|
| CPU | 1 CPU; 0.001–64 in 0.001 increments |
| Memory | 512 MiB; 6 MiB–64 GiB, with swap disabled |
| PIDs | 128; positive integer up to 65,536 |
| Command stdout + stderr | 4 MiB; positive integer up to 16 MiB |
| Command time | 120 seconds; positive integer milliseconds up to 24 hours |
| Temporary storage | 64 MiB `/tmp`, 16 MiB shared memory |

Limits apply per container, not across all Sessions, child scopes or the host control plane. Concurrency multiplies resource consumption. Existing tool-specific limits can be stricter. Output/time limits terminate the owned command container; cgroup memory/PID/CPU values are verified inside it. Unsupported mandatory controls reject acquisition. Unsupported advisory values retain verified defaults with explicit degradation facts. Docker lifetime is Session-scoped; persistent environments and nonempty credential capabilities are unsupported. Kernel/OOM termination may fail a task without producing structured application output.

## Cleanup and recovery

Private receipts live at `profiles/<profile>/execution/docker/` under EstaCoda home. They record profile/workspace ownership, local engine endpoint, creator/controller PIDs, random name/owner tokens, creation phase and full container ID. They contain no command arguments or credentials. Cleanup checks the exact name, full ID and ownership label; it never runs a global prune or adopts a foreign container. Stop and scope release settle only owned resources. Completed commands retire their receipt and retained authority.

A later acquisition can clean receipts for the same workspace/engine only when recorded creator/controller processes are definitely absent. A live or reused PID, or an inaccessible process, is not permission to take over. An interrupted Docker create request without a confirmed result remains uncertain even if the container is not yet listed. Its receipt and runtime ownership must be preserved. An operator must inspect that engine and receipt, establish that creation has settled and remove any matching owned container before manually retiring an unresolved receipt. Do not delete receipts or force handoff merely because a timer expired. This is process-crash recovery, not a power-loss transaction guarantee.

Docker/daemon failure can leave resources pending and disposal blocked. Cancellation cannot undo workspace changes or external network effects already made. The daemon, kernel, approved image, runtime installation and local operator remain trusted. These controls do not isolate malicious same-user host processes or provide multi-tenant hosting, aggregate quotas, persistent shell sessions, managed worktrees, temporary-copy application, or packaged Desktop support.

## Required release gate

After explicit image preparation, run:

```bash
pnpm run validate:execution-docker
```

For an engine that does not share the checkout's temporary filesystem, provide an existing engine-shared parent directory:

```bash
pnpm run validate:execution-docker /path/shared/with/docker
```

The gate creates and removes its own temporary workspace and profile. It fails if Docker, cgroup v2, seccomp or the controlled image is missing; it has no all-skipped success path and never provisions images. It checks both bind modes, files/search/inspection/workers/code, nested host-tool denial, process cancellation, independent scopes, network denial, resource bounds and receipt settlement. Run it alongside the standard source/build/import/smoke checks. The ordinary test suite and host operation do not require a daemon.

Docker's own documentation describes [runtime controls](https://docs.docker.com/engine/containers/run/), [exec behavior](https://docs.docker.com/reference/cli/docker/container/exec/), [container kill semantics](https://docs.docker.com/reference/cli/docker/container/kill/), and the [daemon security boundary](https://docs.docker.com/engine/security/). These are prerequisites to the local threat model, not additional EstaCoda guarantees.
