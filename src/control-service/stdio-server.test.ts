import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { CONTROL_METHODS, CONTROL_LIMITS } from '../contracts/desktop-control/index.js';
import { StdioControlServer, type ControlHandlers } from './stdio-server.js';
import { BoundedLines } from './framing.js';

function fixture(handlers: ControlHandlers = {}, requestTimeoutMs:number|undefined = undefined) {
  const input = new PassThrough(), output = new PassThrough();
  const messages: any[] = [];
  output.on('data', (chunk) => { for (const line of String(chunk).trim().split('\n')) messages.push(JSON.parse(line)); });
  const server = new StdioControlServer({ input, output, profileId: 'p', version: 'test', handlers, requestTimeoutMs });
  const send = (id: string, method: string, params: unknown) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const init = async (profileId = 'p') => { send('init', 'control.initialize', { protocolVersion: { major: 1, minor: 0 }, clientVersion: 'test', profileId, capabilities: { methods: [...CONTROL_METHODS], events: [] } }); await setImmediate(); };
  return { input, output, messages, server, send, init };
}
it('binds initialization and advertised handlers to one profile and rejects premature requests', async () => {
  const f = fixture({ 'work.list': undefined });
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
it('never labels bridge cancellation of a dispatched mutation as confirmed execution cancellation', async () => {
  const f = fixture({ 'sessions.send': async () => await new Promise(() => {}) });
  await f.init(); f.send('mutation', 'sessions.send', { operationId: '100:op', sessionId: 's', target: { targetId: 't', targetGeneration: 1 }, text: 'work' }); await setImmediate();
  f.send('cancel', 'control.cancelRequest', { requestId: 'mutation' }); await setImmediate();
  expect(f.messages.find((m) => m.id === 'mutation').error.code).toBe(-32008);
  expect(f.messages.find((m) => m.id === 'cancel').result).toEqual({ cancellationRequested: true });
  f.server.close(); await f.server.done;
});

it('disposes on abrupt input closure and safely ignores late stream errors', async () => {
  const f = fixture(); let disposed = false; f.server.onDispose(() => { disposed = true; });
  await f.init(); f.input.destroy(); await f.server.done;
  expect(disposed).toBe(true);
  expect(() => f.input.emit('error', new Error('late-stream-canary'))).not.toThrow();
  expect(JSON.stringify(f.messages)).not.toContain('late-stream-canary');
});

it('keeps execution stop, pause and approval resolution reachable when ordinary requests saturate', async () => {
  const reached: string[] = [];
  const priority: ControlHandlers['sessions.cancelTurn'] = async (request) => { reached.push(request.method); return await new Promise(() => {}); };
  const f = fixture({ 'work.list': async () => await new Promise(() => {}), 'sessions.cancelTurn': priority,
    'tasks.cancel': priority, 'tasks.pause': priority, 'approvals.resolve': priority });
  try {
    await f.init();
    for (let i = 0; i < 28; i++) f.send('ordinary-' + i, 'work.list', { limit: 1 });
    const scope = { operationId: '100:review', sessionId: 's', target: { targetId: 't', targetGeneration: 1 } };
    f.send('stop', 'sessions.cancelTurn', scope);
    f.send('task-stop', 'tasks.cancel', { ...scope, taskId: 't' });
    f.send('pause', 'tasks.pause', { ...scope, taskId: 't' });
    f.send('deny', 'approvals.resolve', { ...scope, approvalId: 'a', decision: 'denied' });
    await setImmediate();
    expect(reached).toEqual(['sessions.cancelTurn', 'tasks.cancel', 'tasks.pause', 'approvals.resolve']);
    f.send('overflow', 'work.list', { limit: 1 }); await setImmediate();
    expect(f.messages.find(m => m.id === 'overflow').error.code).toBe(-32009);
  } finally { f.server.close(); await f.server.done; }
});
it('treats cancelled target creation as uncertain even though its operation identity is held in the review',async()=>{
 const f=fixture({'targets.create':async()=>await new Promise(()=>{})});
 await f.init();f.send('create','targets.create',{reviewId:'r',source:{targetId:'t',targetGeneration:1},trustNewPath:true});await setImmediate();
 f.send('cancel','control.cancelRequest',{requestId:'create'});await setImmediate();
 expect(f.messages.find(message=>message.id==='create').error.code).toBe(-32008);
 f.server.close();await f.server.done;
});

it('times out slow target reads before Main disconnects and continues serving requests',async()=>{
 vi.useFakeTimers();let cancelled=false;
 const f=fixture({'targets.list':async(_request,signal)=>{
  await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{cancelled=true;resolve();},{once:true}));
  return{result:{items:[],truncated:false}};
 },'targets.inspectOperation':async()=>({result:{operationId:'op',action:'unknown',state:'unknown',target:null}})});
 try{
  await f.init();f.send('slow','targets.list',{});await vi.advanceTimersByTimeAsync(10_001);
  expect(cancelled).toBe(true);expect(f.messages.filter(row=>row.id==='slow')).toHaveLength(1);expect(f.messages.find(row=>row.id==='slow').error.code).toBe(-32010);
  f.send('receipt','targets.inspectOperation',{operationId:'op'});await vi.advanceTimersByTimeAsync(0);
  expect(f.messages.find(row=>row.id==='receipt').result.state).toBe('unknown');
 }finally{f.server.close();await f.server.done;vi.useRealTimers();}
});
