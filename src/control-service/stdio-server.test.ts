import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { CONTROL_METHODS, CONTROL_LIMITS } from '../contracts/desktop-control/index.js';
import { StdioControlServer, type ControlHandlers } from './stdio-server.js';
import { BoundedLines } from './framing.js';

function fixture(handlers: ControlHandlers = {}, requestTimeoutMs = 30_000) {
  const input = new PassThrough(), output = new PassThrough();
  const messages: any[] = [];
  output.on('data', (chunk) => { for (const line of String(chunk).trim().split('\n')) messages.push(JSON.parse(line)); });
  const server = new StdioControlServer({ input, output, profileId: 'p', version: 'test', handlers, requestTimeoutMs });
  const send = (id: string, method: string, params: unknown) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const init = async (profileId = 'p') => { send('init', 'control.initialize', { protocolVersion: { major: 1, minor: 0 }, clientVersion: 'test', profileId, capabilities: { methods: [...CONTROL_METHODS], events: [] } }); await setImmediate(); };
  return { input, output, messages, server, send, init };
}
it('binds initialization and advertised handlers to one profile and rejects premature requests', async () => {
  const f = fixture();
  f.send('first', 'work.list', { limit: 1 }); await setImmediate();
  expect(f.messages[0].error.code).toBe(-32002);
  await f.init('other'); expect(f.messages[1].error.code).toBe(-32003);
  await f.init(); expect(f.messages[2].result.capabilities.methods).toEqual(['control.initialize', 'control.cancelRequest']);
  f.send('read', 'work.list', { limit: 1 }); await setImmediate(); expect(f.messages.at(-1).error.code).toBe(-32601);
  f.server.close(); await f.server.done;
});
it('cancels pending reads through the priority path and suppresses late replies and raw errors', async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  const f = fixture({ 'work.list': async (_request, abort) => { signal = abort; await new Promise<void>((resolve) => { finish = resolve; }); return { result: { items: [], nextCursor: null } }; },
    'inbox.list': async () => { throw new Error('secret-canary'); } });
  await f.init(); f.send('slow', 'work.list', { limit: 1 }); await setImmediate();
  f.send('cancel', 'control.cancelRequest', { requestId: 'slow' }); await setImmediate();
  expect(signal.aborted).toBe(true);
  expect(f.messages.find((m) => m.id === 'cancel').result.cancellationRequested).toBe(true);
  finish(); await setImmediate(); expect(f.messages.filter((m) => m.id === 'slow')).toHaveLength(1);
  f.send('error', 'inbox.list', { limit: 1 }); await setImmediate();
  expect(JSON.stringify(f.messages)).not.toContain('secret-canary');
  expect(f.messages.at(-1).error.code).toBe(-32603);
  f.input.end(); await f.server.done;
});
it('bounds unterminated bytes and rejects invalid UTF-8 without leaking input', async () => {
  for (const bytes of [Buffer.alloc(CONTROL_LIMITS.frameBytes + 1, 65), Buffer.from([0xc3, 10])]) {
    const f = fixture(); f.input.write(bytes); await f.server.done;
    expect(f.messages).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid control envelope.' } }]);
  }
  const texts: string[] = []; let invalid = false;
  const lines = new BoundedLines(100, (s) => texts.push(s), () => { invalid = true; });
  for (const byte of Buffer.from('مرحبا 🌊\n')) lines.push(Buffer.from([byte]));
  lines.end(); expect(texts).toEqual(['مرحبا 🌊\n']); expect(invalid).toBe(false);
});
it('disconnects boundedly when a peer never drains stdout', async () => {
  const input = new PassThrough();
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  const server = new StdioControlServer({ input, output, profileId: 'p', version: 'test' });
  for (let i = 0; i < 100; i++) input.write('{}\n');
  await server.done; expect(server.closed).toBe(true); expect(output.destroyed).toBe(true);
});
it('aborts pending handlers on close and disposes exactly once', async () => {
  let signal!: AbortSignal, disposed = 0;
  const f = fixture({ 'work.list': async (_r, abort) => { signal = abort; return await new Promise(() => {}); } });
  f.server.onDispose(() => { disposed++; });
  await f.init(); f.send('r', 'work.list', { limit: 1 }); await setImmediate();
  f.server.close(); f.server.close(); await f.server.done;
  expect(signal.aborted).toBe(true); expect(disposed).toBe(1);
});

it('keeps timed-out handlers inside the concurrency bound until they actually settle', async () => {
  let calls = 0;
  const f = fixture({ 'work.list': async () => { calls++; return await new Promise(() => {}); } }, 20);
  await f.init();
  for (let i = 0; i < 28; i++) f.send('slow' + i, 'work.list', { limit: 1 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  f.send('overflow', 'work.list', { limit: 1 }); await setImmediate();
  expect(calls).toBe(28); expect(f.messages.at(-1).error.code).toBe(-32009);
  f.server.close(); await f.server.done;
});
