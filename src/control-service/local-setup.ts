import { verifyOnboarding } from './onboarding-verification.js';
import { supervisorReadiness } from './supervisor-client.js';
import type { LocalSetupInspection } from '../contracts/desktop-control/onboarding.js';

/** Read the selected profile only. This never starts or adopts an execution owner. */
export async function inspectLocalSetup(input: {homeDir: string; profileId: string; version: string}, signal: AbortSignal): Promise<LocalSetupInspection> {
  signal.throwIfAborted();
  const [verification, runtime] = await Promise.all([verifyOnboarding(input), supervisorReadiness({...input, signal})]);
  signal.throwIfAborted();
  const configuration = verification.detection;
  return {
    profileId: input.profileId, configuration, runtime: runtime.state,
    compatibility: runtime.state === 'incompatible' ? 'incompatible' : ['ready', 'stopped'].includes(runtime.state) ? 'compatible' : 'unavailable',
    canConnect: configuration.launchReady && ['ready', 'stopped'].includes(runtime.state)
  };
}
