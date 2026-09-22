import type { DesktopUpdateState } from '../../shared/desktop-updates.js';

/** Explicit scalar allowlist: never serialize a service, receipt, path, error,
 * release record, profile, or runtime configuration into a support export. */
export function updateDiagnostics(state: DesktopUpdateState, input: { platform: string; arch: string; pinsConfigured: boolean; updaterAccepted: boolean }): string {
  const oneOf = (value: unknown, allowed: string[]) => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
  const version = (value: unknown) => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value : 'unavailable';
  return JSON.stringify({
    format: 1,
    desktopVersion: version(state.version), offeredVersion: version(state.availableVersion),
    platform: oneOf(input.platform, ['darwin', 'linux', 'win32']), arch: oneOf(input.arch, ['arm64', 'x64']),
    ownership: oneOf(state.installation.ownership, ['development', 'unsupported', 'mounted', 'translocated', 'external', 'read_only', 'unverified', 'owned']),
    canReplace: state.installation.canReplace === true,
    phase: oneOf(state.phase, ['disabled', 'idle', 'checking', 'current', 'available', 'downloading', 'verifying', 'ready', 'installing', 'installed', 'failed']),
    problem: oneOf(state.problem, ['release_setup', 'check_failed', 'incompatible', 'download_failed', 'insufficient_space', 'verification_failed', 'busy', 'active_runtime', 'restart_blocked', 'recovery_required']),
    automaticChecks: state.automaticChecks === true,
    releasePinsConfigured: input.pinsConfigured === true, updaterAccepted: input.updaterAccepted === true,
  }, null, 2) + '\n';
}
