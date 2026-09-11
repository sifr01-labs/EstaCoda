import { ControlSubscriptions } from './subscriptions.js';
import { RuntimeStateMonitor } from './runtime-notifications.js';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { ControlProtocolError, type BootstrapResult, type ControlCursor } from '../contracts/desktop-control/index.js';
import { profileConfiguration } from './bootstrap.js';
import { supervisorReadiness } from './supervisor-client.js';
import { StdioControlServer } from './stdio-server.js';
export type BootstrapState = Pick<BootstrapResult, 'profile' | 'runtime'>;
/** One bridge per trusted Main client context; Work and execution remain core-owned. */
export class DesktopBridge {
  readonly server: StdioControlServer;
  readonly subscriptions: ControlSubscriptions;
  #generation = 0;
  #monitor: RuntimeStateMonitor | undefined;
  #capture: AbortController | undefined;
  #snapshot: BootstrapResult | undefined;
  constructor(readonly options: { input: Readable; output: Writable; homeDir: string; profileId: string; version: string;
    readState?: (signal: AbortSignal) => Promise<BootstrapState> }) {
    this.server = new StdioControlServer({ ...options, events: ['control.ready', 'service.warning', 'service.shutdown'], handlers: {
      'control.bootstrap': async (_request, signal) => ({ result: await this.bootstrap(signal) }),
      'control.subscribe': (request, signal) => {
        if (request.method !== 'control.subscribe') throw new ControlProtocolError('-32601');
        return this.subscriptions.subscribe(request.params, signal);
      },
      'control.unsubscribe': (request) => {
        if (request.method !== 'control.unsubscribe') throw new ControlProtocolError('-32601');
        return { result: { removed: this.subscriptions.unsubscribe(request.params.subscriptionId) } };
      },
    } });
    this.subscriptions = new ControlSubscriptions(this.server);
    this.server.onDispose(() => { this.#capture?.abort(); this.#monitor?.dispose(); this.#snapshot = undefined; });
  }
  get snapshot(): BootstrapResult | undefined { return this.#snapshot ? structuredClone(this.#snapshot) : undefined; }
  async bootstrap(signal: AbortSignal): Promise<BootstrapResult> {
    const generation = ++this.#generation;
    this.#monitor?.dispose(); this.subscriptions.reset();
    this.#capture?.abort(); this.#capture = new AbortController(); this.#snapshot = undefined;
    const combined = AbortSignal.any([signal, this.#capture.signal]);
    let state: BootstrapState;
    try { state = this.options.readState ? await this.options.readState(combined) : await this.readState(combined); }
    catch (error) { if (generation !== this.#generation) throw new ControlProtocolError('-32007'); throw error; }
    if (generation !== this.#generation || this.server.closed) throw new ControlProtocolError('-32007');
    combined.throwIfAborted();
    if (state.profile.id !== this.server.profileId) throw new ControlProtocolError('-32003');
    const context = this.server.context;
    if (!context) throw new ControlProtocolError('-32002');
    const cursor: ControlCursor = { instanceId: this.server.instanceId, streamId: randomUUID(), sequence: 0 };
    this.#snapshot = structuredClone({ ...state, capabilities: context.capabilities, cursor });
    this.subscriptions.reset(cursor);
    this.subscriptions.publish({ type: 'control.ready', payload: { state: 'ready' } });
    this.#monitor = new RuntimeStateMonitor(state, (signal) => this.options.readState ? this.options.readState(signal) : this.readState(signal),
      (event) => { if (generation === this.#generation && !this.server.closed) { this.subscriptions.publish(event); } });
    return structuredClone(this.#snapshot);
  }
  close(): void {
    this.subscriptions.publish({ type: 'service.shutdown', payload: { reason: 'client_closed' } });
    this.server.close();
  }
  private async readState(signal: AbortSignal): Promise<BootstrapState> {
    const [configuration, runtime] = await Promise.all([profileConfiguration(this.options), supervisorReadiness({ ...this.options, signal })]);
    return { profile: { id: this.server.profileId, label: this.server.profileId, configuration }, runtime };
  }
}
