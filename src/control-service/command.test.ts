import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
it('runs the real private CLI without setup banners or profile writes and shuts down on SIGTERM', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-command-'));
  const child = spawn(process.execPath, ['--import', 'tsx', entry, 'desktop-service', '--stdio', '--profile', 'p'], {
    env: { ...process.env, ESTACODA_HOME: home, OPENAI_API_KEY: 'credential-canary' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    const reply = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop initialization timed out')), 10_000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Desktop exited before initialization')); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'r', method: 'control.initialize', params: {
      protocolVersion: { major: 1, minor: 0 }, clientVersion: 'test', profileId: 'p', capabilities: { methods: ['control.initialize'], events: [] },
    } }) + '\n');
    await reply;
    expect(JSON.parse(stdout.trim()).result.profileId).toBe('p');
    child.kill('SIGTERM'); expect(await closed).toBe(0);
    expect(stdout + stderr).not.toContain('credential-canary'); expect(stderr).toBe('');
    expect(await readdir(home)).toEqual([]);
  } finally { child.kill('SIGKILL'); await closed; await rm(home, { recursive: true, force: true }); }
}, 15_000);
it('requires explicit stdio and profile without falling through to interactive startup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-args-'));
  try {
    for (const args of [['desktop-service', '--stdio'], ['desktop-service', '--profile', 'p'], ['desktop-service', '--stdio', '--profile', 'p', '--version']]) {
      const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], { env: { ...process.env, ESTACODA_HOME: home } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
      const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      expect(status).toBe(2); expect(stdout).toBe(''); expect(stderr).toContain('Invalid Desktop service arguments');
    }
    expect(await readdir(home)).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
}, 15_000);
it('isolates credential submissions and acknowledgements on inherited descriptor 3', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-credential-command-'));
  const child = spawn(process.execPath, ['--import', 'tsx', entry, 'desktop-service', '--stdio', '--profile', 'p', '--credential-fd=3'], {
    env: { ...process.env, ESTACODA_HOME: home }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  let ordinary = '';
  child.stdout!.on('data', (chunk) => { ordinary += chunk; }); child.stderr!.on('data', (chunk) => { ordinary += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const pipe = child.stdio[3] as import('node:stream').Duplex;
  try {
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Credential pipe timed out')), 10_000);
      pipe.once('data', (chunk) => { clearTimeout(timer); resolve(String(chunk)); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Desktop exited before credential acknowledgement')); });
    });
    pipe.write(JSON.stringify({ jsonrpc: '2.0', id: 'stage', method: 'credentials.stage', params: {
      scope: { windowId: 'w', generation: 1, purpose: 'provider', providerId: 'local', authMethod: 'api_key', endpoint: 'http://localhost:8000' }, value: 'credential-canary',
    } }) + '\n');
    const response = await reply; expect(JSON.parse(response).result.candidateId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response).not.toContain('credential-canary'); expect(ordinary).toBe('');
    pipe.end(); expect(await closed).toBe(0); expect(await readdir(home)).toEqual([]);
  } finally { child.kill('SIGKILL'); await closed; await rm(home, { recursive: true, force: true }); }
}, 15_000);
