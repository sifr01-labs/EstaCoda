import { Socket } from 'node:net';
import { attachCredentialPipe } from './credential-pipe.js';
import { DesktopBridge } from './bridge.js';
/** Internal entry point. No setup, profile selection writes, runtime or service installation. */
export async function runDesktopService(input: { profileId: string; homeDir: string; version: string; credentialFd?: 3 }): Promise<void> {
  if (process.stdin.isTTY || process.stdout.isTTY) throw new Error('Desktop requires private stdio pipes.');
  const bridge = new DesktopBridge({ ...input, input: process.stdin, output: process.stdout });
  const { server } = bridge;
  if (input.credentialFd === 3) {
    try {
      const pipe = new Socket({ fd: 3, readable: true, writable: true });
      server.onDispose(attachCredentialPipe(pipe, bridge.candidates, () => server.close()));
    } catch { server.close(true); throw new Error('Credential pipe unavailable.'); }
  }
  const stop = () => bridge.close();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { await server.done; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); server.close(); }
}
