import { StdioControlServer } from './stdio-server.js';
/** Internal entry point. No setup, profile selection writes, runtime or service installation. */
export async function runDesktopService(input: { profileId: string; homeDir: string; version: string }): Promise<void> {
  if (process.stdin.isTTY || process.stdout.isTTY) throw new Error('Desktop requires private stdio pipes.');
  const server = new StdioControlServer({ input: process.stdin, output: process.stdout, profileId: input.profileId, version: input.version });
  const stop = () => server.close();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { await server.done; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); server.close(); }
}
