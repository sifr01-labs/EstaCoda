import { expect, it } from 'vitest';
import { projectRuntimeChange, RuntimeStateMonitor, type RuntimeNotification } from './runtime-notifications.js';
import type { BootstrapState } from './bridge.js';
const state: BootstrapState = { profile: { id: 'p', label: 'P', configuration: 'ready' }, runtime: { state: 'ready' } };
it('projects fixed state-change guidance without copying raw fields or exception text', async () => {
  const events: RuntimeNotification[] = [];
  const monitor = new RuntimeStateMonitor(state, async () => { throw new Error('API_KEY=secret-canary'); }, (event) => events.push(event));
  await monitor.poll(); await monitor.poll();
  expect(events).toEqual([{ type: 'service.warning', payload: { reason: 'resync_required' } }]);
  expect(JSON.stringify(events)).not.toContain('secret-canary'); monitor.dispose();
  expect(projectRuntimeChange(state, { ...state, profile: { ...state.profile, configuration: 'repair_required' } })).toEqual({ type: 'service.warning', payload: { reason: 'configuration_changed' } });
  expect(() => projectRuntimeChange(state, { ...state, profile: { ...state.profile, id: 'other' } })).toThrow('profiles');
});
it('does not overlap polls and suppresses stale callbacks after disposal', async () => {
  let resolve!: (value: BootstrapState) => void, reads = 0; const events: RuntimeNotification[] = [];
  let signal!: AbortSignal;
  const monitor = new RuntimeStateMonitor(state, async (abort) => { signal = abort; reads++; return new Promise((done) => { resolve = done; }); }, (event) => events.push(event));
  const pending = monitor.poll(); await monitor.poll(); expect(reads).toBe(1);
  monitor.dispose(); expect(signal.aborted).toBe(true);
  resolve({ ...state, runtime: { state: 'stopped' } }); await pending;
  expect(events).toEqual([]);
});
