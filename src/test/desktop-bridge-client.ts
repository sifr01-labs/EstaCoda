import {spawn} from 'node:child_process';
import type {Duplex,Readable,Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {CONTROL_EVENTS,CONTROL_METHODS} from '../contracts/desktop-control/index.js';
export function launchDesktopBridge(homeDir: string, profileId: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../index.ts', import.meta.url)), 'desktop-service', '--stdio', '--profile', profileId, '--credential-fd=3'],
    { env: { ...process.env, ESTACODA_HOME: homeDir }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  let ordinary = '';
  child.stdout!.on('data', (chunk) => { ordinary += chunk; }); child.stderr!.on('data', (chunk) => { ordinary += chunk; });
  function channel(input: Writable, output: Readable) {
    let sequence = 0, buffer = '';
    const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    output.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const request = pending.get(message.id); if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
      }
    });
    input.on('error', () => {});
    child.once('exit', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Bridge exited')); } pending.clear(); });
    return (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = 'r' + ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Bridge reply timed out')); }, 8_000);
      pending.set(id, { resolve, reject, timer }); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const rpc = channel(child.stdin!, child.stdout!), pipe = child.stdio[3] as Duplex;
  return { rpc, credential: channel(pipe, pipe), output: () => ordinary,
    initialize: (selected = profileId) => rpc('control.initialize', { protocolVersion: { major: 1, minor: 0 }, clientVersion: 'test', profileId: selected, capabilities: { methods: [...CONTROL_METHODS], events: [...CONTROL_EVENTS] } }),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      try { return await exit; } finally { clearTimeout(timer); }
    },
  };
}
