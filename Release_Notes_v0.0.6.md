# v0.0.6 — Gateway Runtime Supervisor Overhaul

> **Internal checkpoint / pre-release hardening milestone.**  
> This is not the official public release. The official release target remains v0.1.0.

## Summary

v0.0.6 hardens the gateway runtime supervisor with state-file permission hardening, per-channel busy policy configuration, graceful restart and drain, runtime cache and fingerprinting, adapter resilience, hook emissions, and expanded CLI operator controls for channels and gateway lifecycle.

## Highlights

- State file permission hardening (0o600) for all gateway state files
- Per-channel busy policy: reject, queue, interrupt
- Queue depth configuration with clamping [1, 10]
- Gateway graceful restart with active-turn drain (up to 30s)
- Gateway stop with SIGTERM and force termination
- Runtime cache with supervisor fingerprinting
- Active turn registry for parallel-turn prevention
- Adapter resilience supervisor with backoff retry
- Hook registry: runtime, turn, adapter, delivery, cron, supervisor lifecycle
- Channel enable/disable CLI commands
- Extended gateway and channel status visibility
- Clean shutdown marker for crash recovery skip

## Changes

### State File Permission Hardening

- PID file, state file, lock file, runtime cache state, adapter runtime state, and clean-shutdown marker are all created with `0o600` permissions.
- Post-write `chmod(..., 0o600)` corrects existing permissive files.
- Permission tests verify `(mode & 0o777) === 0o600` for all state file writers.

### Per-Channel Busy Policy

- `busyPolicy` values: `"reject"` (default), `"queue"`, `"interrupt"`.
- `queueDepth` defaults to `3`, clamped to `[1, 10]`.
- Each channel configures independently; no top-level global setting.
- Invalid values fall back to `"reject"` with a runtime warning.

### Gateway Lifecycle Commands

- `estacoda gateway stop` — sends SIGTERM and waits for shutdown.
- `estacoda gateway stop --force` — force termination if graceful stop is not desired or fails.
- `estacoda gateway restart` — primitive restart (may interrupt active turns).
- `estacoda gateway restart --graceful` — drains active turns (up to 30s), then restarts.
- `.clean_shutdown` marker written after successful graceful drain; consumed on next startup to skip crash recovery.

### Runtime Cache and Fingerprinting

- `runtime-cache-state.json` persists runtime-cache stats, active-turn stats, suspended summaries, stuck-turn history, supervisor PID/start time, freshness metadata, and fingerprint hash.
- `adapter-runtime-state.json` persists adapter runtime state separately.
- Trustworthy state is gated by freshness (< 5 min) and PID match.
- Runtime fingerprinting prevents reuse of cached runtimes when runtime-affecting configuration changes.

### Active Turn Registry

- Prevents parallel turns per session key.
- Supports turn abort, stuck-turn detection, and busy-ack debounce.
- Wired into ChannelGateway via `activeTurnRegistry` option.

### Adapter Resilience

- `AdapterResilienceSupervisor` wraps each adapter with start/poll retry.
- Exponential backoff with jitter, capped at max delay.
- State transitions: healthy → degraded → retry_scheduled → failed.
- Hook emissions: `adapter:start`, `adapter:error`, `adapter:degraded`, `adapter:retry`, `adapter:recovered`, `adapter:stop`.

### Hook Registry

- Centralized hook registry supports typed emissions across all subsystems.
- Hooks: runtime, turn, adapter resilience, delivery, cron, supervisor lifecycle.
- Hook failures do not affect state transitions or execution flow.

### Channel Operator Controls

- `estacoda channels enable <channel>` — idempotent enable.
- `estacoda channels disable <channel>` — idempotent disable.
- Preserves all other channel fields (tokens, allowlists, busy policy, queue depth).
- Extended `channels status` shows runtime state, identity lock, busy policy, and queue depth.

### Documentation

- `docs/operations/operator-controls.md` — gateway stop/restart, channel enable/disable, busy policy.
- `docs/operations/channel-configuration.md` — new file with per-channel config schema and examples.
- `docs/subsystems/channels.md` — busy policy section, deprecated flag removal.
- `docs/subsystems/cli.md` — removed deprecated `--telegram` start flag example.

## Migration Notes

- Config schema remains compatible; existing `config.json` files continue to work.
- Deprecated per-channel start flags (`--telegram`, `--discord`, `--email`, `--whatsapp`) are no longer the recommended path. Use `estacoda channels enable <channel>` followed by `estacoda gateway start`.
- No breaking changes to runtime behavior.

## Contributors

- See git log since v0.0.5.
