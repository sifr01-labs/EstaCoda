import { expect, it } from 'vitest';
import { updateDiagnostics } from './diagnostics.js';
import type { DesktopUpdateState } from '../../shared/desktop-updates.js';
it('exports only bounded status scalars, including when unexpected fields or values contain private data', () => {
  const secret = 'PRIVATE_CANARY/profile/key/chat';
  const state = { version: '1.0.0', phase: 'failed', problem: 'check_failed', installation: { ownership: 'unverified', canReplace: false }, automaticChecks: false, notesUrl: secret, receipt: secret, error: secret, profileId: secret };
  const input = { platform: 'darwin', arch: 'arm64', pinsConfigured: false, updaterAccepted: false };
  const result = updateDiagnostics(state as DesktopUpdateState, input);
  expect(result).not.toContain(secret); expect(JSON.parse(result)).toMatchObject({ desktopVersion: '1.0.0', problem: 'check_failed', canReplace: false });
  for (const key of ['version', 'availableVersion', 'phase', 'problem']) expect(updateDiagnostics({ ...state, [key]: secret } as DesktopUpdateState, input)).not.toContain(secret);
  expect(updateDiagnostics({ ...state, installation: { ownership: secret, canReplace: false } } as unknown as DesktopUpdateState, { ...input, platform: secret, arch: secret })).not.toContain(secret);
});
