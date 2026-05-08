# Changelog

## v0.0.6

### Gateway Runtime Supervisor Overhaul

- Harden state file permissions (0o600) for PID, state, lock, runtime cache, adapter runtime, and clean-shutdown files.
- Add per-channel `busyPolicy` (`reject`, `queue`, `interrupt`) and `queueDepth` (clamped [1, 10]).
- Add gateway stop/restart CLI commands with graceful drain (30s) and force termination.
- Add runtime cache, fingerprinting, and active turn registry.
- Add adapter resilience supervisor with backoff retry and hook emissions.
- Add centralized hook registry for runtime, turn, adapter, delivery, cron, and supervisor lifecycle events.
- Add channel enable/disable CLI commands.
- Extend gateway and channel status visibility.
- Update operator documentation.

See `Release_Notes_v0.0.6.md` for full details.

## v0.0.5

- See `Release_Notes_v0.0.5.md`

## v0.0.4

- See `Release_Notes_v0.0.4.md`

## v0.0.3

- See `Release_Notes_v0.0.3.md`
