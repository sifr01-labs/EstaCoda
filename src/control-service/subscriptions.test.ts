import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { CONTROL_EVENTS, CONTROL_METHODS } from '../contracts/desktop-control/index.js';
import { DesktopBridge } from './bridge.js';
async function fixture() {
  const input = new PassThrough(), output = new PassThrough(); const messages: any[] = [];
  output.on('data', (chunk) => { messages.push(JSON.parse(String(chunk))); });
  const bridge = new DesktopBridge({ input, output, homeDir: '/unused', profileId: 'p', version: 'test',
    readWork: async () => ({ work: [], activity: {} }),
    readState: async () => ({ profile: { id: 'p', label: 'P', configuration: 'unconfigured' }, runtime: { state: 'stopped' } }) });
  const send = async (id: string, method: string, params: unknown) => { input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); await setImmediate(); return messages.find((message) => message.id === id); };
  await send('init', 'control.initialize', { protocolVersion: { major: 1, minor: 0 }, clientVersion: 'test', profileId: 'p', capabilities: { methods: [...CONTROL_METHODS], events: [...CONTROL_EVENTS] } });
  const bootstrap = (await send('boot', 'control.bootstrap', {})).result;
  return { input, output, messages, bridge, send, bootstrap };
}
it('acknowledges subscriptions before ordered replay and keeps burst/live events contiguous', async () => {
  const f = await fixture();
  for (let i = 0; i < 100; i++) f.bridge.subscriptions.publish({ type: 'service.warning', payload: { reason: 'resync_required' } });
  const ack = await f.send('subscribe', 'control.subscribe', { after: f.bootstrap.cursor, events: f.bootstrap.capabilities.events });
  for (let i = 0; i < 10; i++) f.bridge.subscriptions.publish({ type: 'service.warning', payload: { reason: 'configuration_changed' } });
  for (let i = 0; i < 20 && f.messages.filter((m) => m.method === 'control.event').length < 111; i++) await setImmediate();
  const events = f.messages.filter((m) => m.method === 'control.event');
  expect(f.messages.indexOf(ack)).toBeLessThan(f.messages.indexOf(events[0]));
  expect(events.map((m) => m.params.cursor.sequence)).toEqual(Array.from({ length: 111 }, (_, i) => i + 1));
  expect(events.every((m) => m.params.subscriptionId === ack.result.subscriptionId && m.params.profileId === 'p')).toBe(true);
  expect((await f.send('unsubscribe', 'control.unsubscribe', { subscriptionId: ack.result.subscriptionId })).result.removed).toBe(true);
  f.bridge.subscriptions.publish({ type: 'service.warning', payload: { reason: 'resync_required' } }); await setImmediate();
  expect(f.messages.filter((m) => m.method === 'control.event')).toHaveLength(111);
  f.bridge.close(); await f.bridge.server.done;
});
it('requires resync for expired cursors, filtered event coverage and replaced snapshots', async () => {
  const f = await fixture();
  for (let i = 0; i < 256; i++) f.bridge.subscriptions.publish({ type: 'service.warning', payload: { reason: 'resync_required' } });
  expect((await f.send('expired', 'control.subscribe', { after: f.bootstrap.cursor, events: f.bootstrap.capabilities.events })).result).toEqual({ state: 'snapshot_required', reason: 'cursor_expired' });
  const next = (await f.send('refresh', 'control.bootstrap', {})).result;
  expect((await f.send('old', 'control.subscribe', { after: f.bootstrap.cursor, events: f.bootstrap.capabilities.events })).result.reason).toBe('stream_changed');
  expect((await f.send('filtered', 'control.subscribe', { after: next.cursor, events: ['control.ready'] })).result.reason).toBe('stream_changed');
  f.bridge.close(); await f.bridge.server.done;
});
it('bounds subscription reservations and drops a reservation cancelled before acknowledgement', async () => {
  const f = await fixture();
  const params = { after: f.bootstrap.cursor, events: f.bootstrap.capabilities.events };
  const abort = new AbortController();
  const first = f.bridge.subscriptions.subscribe(params, abort.signal); abort.abort(); first.afterReply?.();
  for (let i = 0; i < 32; i++) f.bridge.subscriptions.subscribe(params, new AbortController().signal);
  expect(() => f.bridge.subscriptions.subscribe(params, new AbortController().signal)).toThrow('limit');
  f.bridge.close(); await f.bridge.server.done;
});
it('expires replay by total byte budget even before the event-count limit', async () => {
  const { StdioControlServer } = await import('./stdio-server.js');
  const { ControlSubscriptions } = await import('./subscriptions.js');
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const server = new StdioControlServer({ input, output, profileId: 'p', version: 'test', events: ['activity.appended'] });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'control.initialize', params: { protocolVersion: { major: 1, minor: 0 }, clientVersion: 'test', profileId: 'p', capabilities: { methods: ['control.initialize'], events: ['activity.appended'] } } }) + '\n');
  await setImmediate();
  const subscriptions = new ControlSubscriptions(server);
  const cursor = { instanceId: server.instanceId, streamId: 'stream', sequence: 0 }; subscriptions.reset(cursor);
  for (let i = 0; i < 70; i++) subscriptions.publish({ type: 'activity.appended', payload: { id: 'a' + i, workId: 'w', profileId: 'p', sequence: i, timestamp: 1, kind: 'message', role: 'assistant', text: 'x'.repeat(16_000) } });
  expect(subscriptions.subscribe({ after: cursor, events: ['activity.appended'] }, new AbortController().signal).result).toEqual({ state: 'snapshot_required', reason: 'cursor_expired' });
  server.close(); await server.done;
});
