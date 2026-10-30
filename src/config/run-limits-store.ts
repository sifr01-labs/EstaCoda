import { readConfig } from './runtime-config.js';
import { resolveProfileStateHome } from './profile-home.js';
import { normalizeRunLimits, unattendedRunLimits } from './run-limits.js';

/** Snapshot once per visible turn, from the selected profile only. */
export async function readRunLimits(input: { homeDir?: string; profileId: string }) {
  const snapshot = await readConfig(resolveProfileStateHome(input).configPath);
  return {...normalizeRunLimits(snapshot.config.runLimits),unattended:unattendedRunLimits(snapshot.config)};
}

export async function readUnattendedRunLimits(input:{homeDir?:string;profileId:string}){
  return unattendedRunLimits((await readConfig(resolveProfileStateHome(input).configPath)).config);
}
