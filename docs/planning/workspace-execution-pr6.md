# Workspace execution PR 6 implementation record

Status: implemented on `ame/execution-baseline` in the nine prescribed commits. This slice adds optional local Docker execution while preserving daemon-independent Local host workflows. See [operator guidance and residual risks](../operations/docker-execution.md).

## Commit sequence

1. `85e4a388` — selected-profile Docker policy, read-only capability probing and reviewed image preparation through Setup Editor.
2. `06aa9ea9` — uniquely owned containers, controlled immutable images, safe bind roots and verification of effective security controls.
3. `c6811b9f` — bounded container file operations, both bind modes, Unicode and traversal/symlink checks.
4. `8e3b4475` — backend-neutral leases, independent command controllers, managed processes, Python workers and code-harness transport.
5. `64c75422` — host-tool admission boundary, scoped gateway/cron authority, profile-policy invalidation and stricter mount/control verification.
6. `cacdf28f` — mandatory/advisory limits with effective cgroup v2 verification and bounded command output/time.
7. `7a706233` — durable profile-local receipts, exact ownership cleanup, independent cancellation and conservative crash recovery.
8. `478bad82` — required Docker release gate and fixes exposed by real parity checks: backend shell/PWD/inspection handling, ACP authority, cron interpreter selection, current Node image and recovery tests.
9. `docs(execution): document sandbox setup authority and residual risks` — operator guidance, migration, validation record and plan status.

Each implementation slice was reviewed and checked before its commit. The acceptance commit incorporates cross-surface and real-engine findings instead of leaving known parity failures deferred.

## Acceptance evidence

| Requirement | Implemented and checked |
|---|---|
| Optional setup | Existing host default; selected-profile config only; probe cannot pull; reviewed apply prepares an immutable controlled image. Setup/apply and policy tests preserve cancellation and security configuration. |
| Effective controls | Inspection verifies image, UID, bind/propagation, read-only root, capabilities, privilege, namespaces, devices, networking and resource settings. In-container checks verify non-root execution, seccomp, no-new-privileges, zero effective capabilities and cgroup v2 values. Negative unit tests reject drift. |
| Complete core execution parity | Real-engine gate exercises files, both bind modes, shell/inspection, grep/glob, notebooks, document worker, `execute_code`, nested file calls and managed processes. Arabic text survives the file/worker path. |
| No implicit host escape | Host-only tools remain visible but receive an admission blocker. A nested host-network call remains blocked under an allowing security policy. Structured document tools cannot use host-only extra roots. Missing engines/images and required controls fail closed. |
| Network and bind authority | The gate attempts an outbound connection under network-none, verifies explicit bridge mode, rejects structured and command writes to a read-only bind, and checks changed authority fingerprints. Writable binds retain immediate host mutation risk. |
| Scope and cleanup | Real command cancellation leaves an independent child scope usable. Receipts settle after normal commands, limits and cleanup. Unit tests cover foreign-label rejection, uncertain creation preservation, live-owner exclusion and confirmed-dead recovery. |
| Existing workflows | Regression coverage includes CLI/ACP, gateway/cache/approvals, cron, source and compiled smoke. Local host does not connect to Docker. |
| Required release gate | `validate:execution-docker` has no skip path. A deliberately missing local socket produces failure. Source and compiled-module Docker runs pass against the final controlled image. |

## Validation

Checks ran in an isolated temporary checkout synchronized with tracked source and explicitly reviewed new files. The operator checkout's pre-existing untracked duplicate files and `exports/` were excluded and left untouched. No JavaScript dependency or lockfile change was required. The controlled Docker image intentionally downloads its reviewed base images and OS packages during provisioning.

- Node v24.14.1 and pnpm 10.33.0; `CI=true pnpm install --frozen-lockfile` passed.
- Per-commit focused tests and typecheck passed.
- Full `pnpm run test`: **10,549 tests in 620 files passed**. The initial sandboxed run denied two existing Unix-socket tests; the full rerun with local IPC access passed.
- Subsequent final ACP, cron, execution, process, inspection and live-authority checks: **105 tests in 18 files passed**, including the additional dead-owner recovery test and final cross-surface fixes.
- Final typecheck, build, runtime-import audit and ESM audit passed.
- Source and compiled smoke: **13/13 cases passed in each**.
- Real Docker source and compiled-module gates passed on macOS with a local Colima Linux/cgroup v2/seccomp engine. Both gates used the final controlled Python 3.12 / Node 22 image.
- Missing-daemon gate failed as required; no tests were silently skipped.
- `git diff --check` and local documentation-link validation passed.

## Security review and remaining limits

This changes sensitive command, filesystem, approval, setup, runtime and recovery surfaces. The mandatory floor remains in place; writable mounts keep host-equivalent workspace risk. Docker is a local trusted-operator boundary, not multi-tenant managed infrastructure. The entire bind is visible to arbitrary commands, including project secrets. Direct networking is broad engine networking. Host provider/control-plane traffic is separate, and unadapted host tools are blocked.

The execution strategy creates a container per command or file operation. This is deliberate for independent cancellation, but adds material latency; aggregate quotas, throughput, production cost and long-running workload behavior are not established. Limits are per container. Persistent shells/environments, credential capabilities, remote daemons, Windows engines, packaged Desktop integration, managed worktrees and temporary-copy/change application remain outside this slice.

An interrupted create can remain uncertain; receipts and execution ownership are retained rather than declaring cleanup complete. Recovery requires confirmed process absence and exact ownership. PID reuse does not authorize takeover. Cancellation cannot undo workspace writes or external effects. Kernel/daemon compromise, malicious same-user host mutation and power-loss durability are outside the demonstrated boundary.

Node 22 host CI, other engine/OS versions, real provider/channel accounts, packaged Desktop surfaces and production performance remain release-matrix work. Docker adds a useful governed execution boundary; it does not by itself complete a managed multi-tenant service.
