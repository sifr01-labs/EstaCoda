import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { CONTROL_LIMITS, ControlProtocolError, cursorDisposition, parseControlFrame, serializeControlFrame,
  validateControlRequest, validateControlResponse, validateEventNotification,
  type ControlContext, type ControlCursor, type MethodContracts, type MethodRequest, type RpcEnvelope,
  type SubscriptionContext, type InitializeResult, type BootstrapResult, type SubscribeResult } from '@estacoda/control-protocol';

type Pending = { request: MethodRequest; context: ControlContext | null; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
/** Strict bounded framing before decoding, correlation before projection. */
export class ProtocolClient extends EventEmitter {
  context: ControlContext | null = null;
  #subscription: SubscriptionContext | null = null;
  #cursor: ControlCursor | null = null;
  #pending = new Map<string, Pending>();
  #buffer = Buffer.alloc(0);
  #closed = false;
  constructor(readonly input: Writable, readonly output: Readable, readonly timeoutMs = 15_000) {
    super(); output.on('data', this.receive); output.once('end', this.failed); output.once('error', this.failed);
    input.once('error', this.failed);
  }
  async request<M extends keyof MethodContracts>(method: M, params: MethodContracts[M]['params']): Promise<MethodContracts[M]['result']> {
    if (this.#closed || this.#pending.size >= 32 || this.input.writableLength > CONTROL_LIMITS.frameBytes) throw new ControlProtocolError('-32006');
    const request = { jsonrpc: '2.0', id: randomUUID(), method, params } as MethodRequest<M>;
    validateControlRequest(request, this.context);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failed(), ['targets.create','targets.execute'].includes(method)?Math.max(this.timeoutMs,120_000):this.timeoutMs); timer.unref();
      this.#pending.set(request.id, { request, context: this.context, resolve: value => resolve(value as MethodContracts[M]['result']), reject, timer });
      this.input.write(serializeControlFrame(request as RpcEnvelope));
    });
  }
  private receive = (chunk: Buffer): void => {
    if (this.#closed) return;
    try {
      if (!Buffer.isBuffer(chunk)) throw new Error();
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline + 1;
        if (this.#buffer.length + end - offset > CONTROL_LIMITS.frameBytes) throw new Error();
        this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(offset, end)]); offset = end;
        if (newline < 0) break;
        const frame = new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer); this.#buffer = Buffer.alloc(0);
        this.accept(parseControlFrame(frame));
      }
    } catch { this.failed(); }
  };
  private accept(message: RpcEnvelope): void {
    if ('method' in message) {
      if (!this.context || !this.#subscription || !this.#cursor) throw new Error();
      const event = validateEventNotification(message, this.context, this.#subscription).params;
      const disposition = cursorDisposition(this.#cursor, event.cursor);
      if (disposition === 'snapshot_required') { this.emit('resync'); return; }
      if (disposition === 'duplicate') return;
      this.#cursor = event.cursor; this.emit('event', event); return;
    }
    const pending = message.id === null ? undefined : this.#pending.get(message.id);
    if (!pending) throw new Error();
    const response = validateControlResponse(message, pending.request, pending.context);
    this.#pending.delete(pending.request.id); clearTimeout(pending.timer);
    if ('error' in response) { pending.reject(new ControlProtocolError(String(response.error.code) as ConstructorParameters<typeof ControlProtocolError>[0])); return; }
    // Bind before resolving: a notification may follow the response in this chunk.
    if (pending.request.method === 'control.initialize') {
      const value = response.result as InitializeResult;
      this.context = { profileId: value.profileId, instanceId: value.instanceId, capabilities: value.capabilities };
    } else if (pending.request.method === 'control.bootstrap') {
      this.#cursor = (response.result as BootstrapResult).cursor; this.#subscription = null;
    } else if (pending.request.method === 'control.subscribe') {
      const value = response.result as SubscribeResult;
      if (value.state === 'subscribed') {
        this.#cursor = value.cursor;
        this.#subscription = { subscriptionId: value.subscriptionId, streamId: value.cursor.streamId, events: this.context!.capabilities.events };
      }
    }
    pending.resolve(response.result);
  }
  private failed = (): void => { if (!this.#closed) { this.dispose(); this.emit('disconnected'); } };
  dispose(): void {
    this.#closed = true; this.#buffer = Buffer.alloc(0); this.context = null; this.#subscription = null; this.#cursor = null;
    this.output.off('data', this.receive).off('end', this.failed).off('error', this.failed); this.input.off('error', this.failed);
    for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(new ControlProtocolError('-32006')); }
    this.#pending.clear();
  }
}
