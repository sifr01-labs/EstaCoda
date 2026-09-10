# PR 5 / PR 6 review fixes

The six concrete review findings are addressed together on `ame/execution-baseline`. This record supplements the original PR 5 and PR 6 implementation records; it does not expand the Docker host-capability boundary.

| Finding | Implemented correction |
|---|---|
| Docker cleanup failure was permanently cached | Failed receipt cleanup can be retried. Scope/environment cleanup retains failed resources, does not replay successful cleanup, and keeps released authority revoked. Container release retains ownership until settlement is proven. |
| No required Docker CI lane | CI has a separate `Docker execution parity` job that explicitly builds the controlled image, invokes the non-skipping execution gate, and validates the existing package image. Making that status mandatory for merges requires remote branch-protection configuration. |
| Docker reads inherited the smaller command-output cap | File RPC uses a separate 12 MiB frame bound. Host and Docker both read 8 MiB files, even when model command output is restricted to 1 KiB. Oversized files remain rejected. |
| Selected channel workspaces bypassed automatic resets | Activity and idle/daily Session rotation commit atomically in the profile workspace store. Competing callers reread the selection; target/source bindings remain unchanged. Legacy rows establish a first-use baseline, stale timestamps cannot move activity backward, and explicit attachment precedence is preserved. |
| Channels always displayed Local host | Both gateway construction paths supply selected profile policy. Inspection/selection replies label the configured backend and Docker mount/network settings without claiming verified live execution. |
| Every file operation created another container | Structured file RPCs reuse a dedicated scope-owned container. Each request verifies effective controls and runs the bundled helper in isolated Python. Commands keep separate containers. Cancelling a file scope removes only its own container. |

## Review and validation

Review traced source/compiled packaging, scope release and retry, approval retention on uncertain cleanup, creation/cancellation races, request/output/queue bounds, ordinary file errors, immutable channel targets, concurrent selection/reset, and both gateway wiring paths. No remaining gaps were found within these six findings.

Validation ran in the isolated tracked checkout to exclude the operator's unrelated untracked duplicates and `exports/`. No dependencies or lockfiles changed.

- Node 24.14.1 and pnpm 10.33.0; frozen dependency install passed after retrying with registry access.
- Final full suite: **10,566 tests in 621 files passed**.
- Typecheck, build, runtime-import audit and ESM audit passed.
- Source and compiled smoke: **13/13 cases passed in each**.
- Real source and compiled Docker gates passed on the existing local Colima Linux/cgroup-v2/seccomp engine. The final compiled gate additionally exercised revoked-parent cleanup retry.
- Gate coverage includes 8 MiB read parity, oversized rejection, unchanged 1 KiB command output enforcement, zero container creation on warm reads, independent file/command scopes, both bind modes, no host fallback, containment and empty receipt journals after cleanup.
- Existing package-image validation passed: image build and containerized CLI version/help checks, using the existing Node 22.18.0 package Dockerfile.
- Workflow YAML and explicit Docker gate wiring validated locally; remote GitHub Actions and branch protection were not exercised.
- `git diff --check` passed.

Three warm reads took 880 ms in the source gate and 1,485 ms in the compiled gate while other checks ran, versus roughly 3,288 ms in the earlier local probe. These are individual local observations, not a throughput benchmark or production latency guarantee. The deterministic acceptance assertion is zero new containers for warm file reads.

## Risk and scope

Filesystem, command lifecycle, durable routing and CI are security-sensitive. File workers accept bounded structured operations, never provider-supplied executable code; regular-file, sensitive-path and symlink checks remain in place. Full mount scans remain at acquisition and on each arbitrary command's new container. File RPC has a 30-second execution timeout and queues at most 128 requests / 24 MiB of input. CPU, memory, PID, bind and network verification still applies. Failed transport revokes the file scope; ordinary file errors leave it reusable. Uncertain cleanup retains receipts and authority for explicit settlement.

Writable binds still change the host workspace immediately. Limits are per container, not aggregate quotas. Provider/control-plane traffic and blocked host capabilities retain their existing treatment. Multi-tenant isolation, credential capabilities, Windows/remote engines, production performance and the remaining release matrix remain separate work.
