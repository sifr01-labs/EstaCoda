import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  ControlProtocolError, serializeControlFrame, validateEventNotification,
  type ControlCursor, type ControlEvent, type EventNotification, type SubscribeParams, type SubscribeResult,
} from '../contracts/desktop-control/index.js';
import type { StdioControlServer } from './stdio-server.js';
export type SafeNotification = { [K in ControlEvent['type']]: Pick<Extract<ControlEvent, { type: K }>, 'type' | 'payload'> }[ControlEvent['type']];
type Subscription = { id: string; next: number; active: boolean; pumping: boolean; cleanup: () => void };
type Retained = { event: ControlEvent; bytes: number };
/** One profile/instance/negotiated-event stream. Replay is a bounded cache, never a durable queue. */
export class ControlSubscriptions {
  readonly #subscribers = new Map<string, Subscription>();
  readonly #records: Retained[] = [];
  #bytes = 0;
  #cursor: ControlCursor | undefined;
  #floor = 0;
  constructor(readonly server: StdioControlServer) { server.onDispose(() => this.reset()); }
  reset(cursor?: ControlCursor): void {
    for (const sub of this.#subscribers.values()) sub.cleanup();
    this.#subscribers.clear(); this.#records.length = 0; this.#bytes = 0;
    this.#cursor = cursor ? { ...cursor } : undefined; this.#floor = cursor?.sequence ?? 0;
  }
  publish(notification: SafeNotification): boolean {
    const context = this.server.context;
    if (!context || !this.#cursor || this.server.closed || !context.capabilities.events.includes(notification.type)) return false;
    const cursor = { ...this.#cursor, sequence: this.#cursor.sequence + 1 };
    const event = { ...notification, profileId: context.profileId, subscriptionId: 'journal', cursor, timestamp: Date.now() } as ControlEvent;
    const envelope: EventNotification = { jsonrpc: '2.0', method: 'control.event', params: event };
    validateEventNotification(envelope, context, { subscriptionId: 'journal', streamId: cursor.streamId, events: context.capabilities.events });
    // Include room for the actual UUID subscription ID in retained-byte accounting.
    const bytes = Buffer.byteLength(serializeControlFrame(envelope)) + 32;
    this.#records.push({ event: structuredClone(event), bytes }); this.#bytes += bytes; this.#cursor = cursor;
    while (this.#records.length > 256 || this.#bytes > 1_048_576) {
      const removed = this.#records.shift()!; this.#bytes -= removed.bytes; this.#floor = removed.event.cursor.sequence;
    }
    for (const sub of this.#subscribers.values()) this.schedule(sub);
    return true;
  }
  subscribe(params: SubscribeParams, signal: AbortSignal): { result: SubscribeResult; afterReply?: () => void } {
    const cursor = this.#cursor, context = this.server.context;
    if (!cursor || !context || params.after.streamId !== cursor.streamId || context.capabilities.events.length !== params.events.length ||
      !context.capabilities.events.every((event) => params.events.includes(event))) return { result: { state: 'snapshot_required', reason: 'stream_changed' } };
    if (params.after.instanceId !== cursor.instanceId) return { result: { state: 'snapshot_required', reason: 'instance_changed' } };
    if (params.after.sequence < this.#floor || params.after.sequence > cursor.sequence) return { result: { state: 'snapshot_required', reason: 'cursor_expired' } };
    if (this.#subscribers.size >= 32) throw new ControlProtocolError('-32009');
    signal.throwIfAborted();
    const id = randomUUID();
    const cancel = () => { this.unsubscribe(id); };
    const sub: Subscription = { id, next: params.after.sequence + 1, active: false, pumping: false,
      cleanup: () => signal.removeEventListener('abort', cancel) };
    signal.addEventListener('abort', cancel, { once: true }); this.#subscribers.set(id, sub);
    return { result: { state: 'subscribed', subscriptionId: id, cursor: { ...params.after } }, afterReply: () => {
      if (signal.aborted || this.#subscribers.get(id) !== sub) return;
      sub.cleanup(); sub.active = true; this.schedule(sub);
    } };
  }
  unsubscribe(id: string): boolean { const sub = this.#subscribers.get(id); if (!sub) return false; sub.cleanup(); return this.#subscribers.delete(id); }
  private schedule(sub: Subscription): void {
    if (!sub.active || sub.pumping) return;
    sub.pumping = true;
    void this.pump(sub).catch(() => this.server.close(true)).finally(() => {
      sub.pumping = false;
      if (!this.server.closed && this.#subscribers.get(sub.id) === sub && this.#cursor && sub.next <= this.#cursor.sequence) this.schedule(sub);
    });
  }
  private async pump(sub: Subscription): Promise<void> {
    let batch = 0;
    while (!this.server.closed && this.#subscribers.get(sub.id) === sub && this.#cursor && sub.next <= this.#cursor.sequence) {
      if (sub.next <= this.#floor) { this.server.close(true); return; }
      const first = this.#records[0]?.event.cursor.sequence;
      const record = first === undefined ? undefined : this.#records[sub.next - first];
      if (!record) { this.server.close(true); return; }
      const context = this.server.context!;
      const event = { ...record.event, subscriptionId: sub.id } as ControlEvent;
      if (!this.server.notify({ jsonrpc: '2.0', method: 'control.event', params: event }, { subscriptionId: sub.id, streamId: event.cursor.streamId, events: context.capabilities.events })) return;
      sub.next++;
      if (++batch % 16 === 0) await setImmediate();
    }
  }
}
