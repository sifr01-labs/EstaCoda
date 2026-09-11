import { lstat } from 'node:fs/promises';
import { resolveProfileStateHome } from '../config/profile-home.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import type { BootstrapResult } from '../contracts/desktop-control/index.js';
/** Configuration loading uses core's selected-profile normalization, never a workspace config. */
export async function profileConfiguration(input: { homeDir: string; profileId: string }): Promise<BootstrapResult['profile']['configuration']> {
  const paths = resolveProfileStateHome(input);
  try {
    const directory = await lstat(paths.profileRoot);
    if (directory.isSymbolicLink() || !directory.isDirectory()) return 'repair_required';
    const config = await loadRuntimeConfig({ ...input, workspaceRoot: input.homeDir, configurationInspection: true });
    return config.model.provider === 'unconfigured' || config.model.id === 'unconfigured' ? 'unconfigured' : 'ready';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unconfigured' : 'repair_required';
  }
}
