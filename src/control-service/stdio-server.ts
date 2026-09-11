import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { normalizeProfileId } from '../config/profile-home.js';
import {
  CONTROL_LIMITS, ControlProtocolError, failureEnvelope, isControlId, negotiateControl,
  parseControlFrame, serializeControlFrame, validateControlRequest, validateControlResponse,
  validateEventNotification, type Capabilities, type ControlContext, type ControlEventType,
  type ControlMethod, type EventNotification, type JsonValue, type MethodRequest,
  type RpcEnvelope, type SubscriptionContext,
} from '../contracts/desktop-control/index.js';
import { BoundedLines } from './framing.js';

export type Reply = { result: JsonValue; afterReply?: () => void };
export type ControlHandler = (request: MethodRequest, signal: AbortSignal) => Reply | Promise<Reply>;
export type ControlHandlers = Partial<Record<Exclude<ControlMethod, 'control.initialize' | 'control.cancelRequest'>, ControlHandler>>;
/** Owns only this private client connection. It never owns an execution host. */
export class StdioControlServer {
  readonly instanceId = randomUUID();
  readonly profileId: string;
  readonly done: Promise<void>;
  readonly #handlers: ControlHandlers;
  readonly #pending = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
  readonly #frames: string[] = [];
  #queuedBytes = 0;
  #blocked = false;
  #closed = false;
  #context: ControlContext | null = null;
  #initializing = false;
  #finish!: () => void;
  readonly #lines: BoundedLines;
  readonly #disposers = new Set<() => void>();
  constructor(readonly options: {
    input: Readable; output: Writable; profileId: string; version: string;
    handlers?: ControlHandlers; events?: ControlEventType[]; requestTimeoutMs?: number;
  }) {
    this.profileId = normalizeProfileId(options.profileId);
    if (!isControlId(this.profileId)) throw new Error('Invalid Desktop profile.');
    this.#handlers = { ...options.handlers };
    this.done = new Promise((resolve) => { this.#finish = resolve; });
    this.#lines = new BoundedLines(CONTROL_LIMITS.frameBytes, (frame) => this.receive(frame), () => this.fault());
    options.input.on('data', this.onData);
    options.input.on('end', this.onEnd);
    options.input.on('error', this.onError);
    options.output.on('error', this.onError);
    options.output.on('close', this.onError);
    options.output.on('drain', this.onDrain);
  }
  get context(): ControlContext | null { return this.#context ? structuredClone(this.#context) : null; }
  get closed(): boolean { return this.#closed; }
  onDispose(dispose: () => void): void { if (this.#closed) dispose(); else this.#disposers.add(dispose); }
  notify(event: EventNotification, subscription: SubscriptionContext): boolean {
    if (!this.#context || this.#closed) return false;
    validateEventNotification(event, this.#context, subscription);
    return this.write(event);
  }
  readonly onData = (chunk: Buffer): void => { if (!Buffer.isBuffer(chunk)) { this.fault(); return; } this.#lines.push(chunk); };
  readonly onEnd = (): void => { this.#lines.end(); this.close(); };
  readonly onError = (): void => { this.close(true); };
  readonly onDrain = (): void => {
    this.#blocked = false;
    while (this.#frames.length && !this.#blocked && !this.#closed) {
      const frame = this.#frames.shift()!; this.#queuedBytes -= Buffer.byteLength(frame);
      this.#blocked = !this.options.output.write(frame);
    }
  };
  private fault(): void { this.write(failureEnvelope(null, '-32600')); this.close(); }
  private write(value: RpcEnvelope): boolean {
    if (this.#closed) return false;
    const frame = serializeControlFrame(value);
    if (this.#blocked) {
      const bytes = Buffer.byteLength(frame);
      if (this.#frames.length >= 64 || this.#queuedBytes + bytes > 1_048_576) { this.close(true); return false; }
      this.#frames.push(frame); this.#queuedBytes += bytes;
    } else this.#blocked = !this.options.output.write(frame);
    return true;
  }
  private receive(frame: string): void {
    let request: MethodRequest;
    let requestId: string | null = null;
    try {
      const envelope = parseControlFrame(frame);
      if ('id' in envelope && typeof envelope.id === 'string') requestId = envelope.id;
      request = validateControlRequest(envelope, this.#context);
      if (this.#pending.has(request.id) || (request.method === 'control.initialize' && this.#initializing)) { this.fault(); return; }
      const priority = request.method === 'control.cancelRequest' || request.method === 'control.unsubscribe';
      if (this.#pending.size >= (priority ? 32 : 28)) throw new ControlProtocolError('-32009');
    } catch (error) {
      this.write(failureEnvelope(requestId, error instanceof ControlProtocolError ? error.code : '-32603'));
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      this.write(failureEnvelope(request.id, '-32010'));
    }, this.options.requestTimeoutMs ?? 30_000);
    this.#pending.set(request.id, { controller, timer });
    if (request.method === 'control.initialize') this.#initializing = true;
    void this.dispatch(request, controller.signal).then((reply) => {
      if (controller.signal.aborted || this.#closed) return;
      const response = { jsonrpc: '2.0' as const, id: request.id, result: reply.result };
      validateControlResponse(response, request, this.#context);
      if (request.method === 'control.initialize') {
        const result = reply.result as unknown as { capabilities: Capabilities };
        this.#context = { profileId: this.profileId, instanceId: this.instanceId, capabilities: result.capabilities };
      }
      if (this.write(response)) {
        try { reply.afterReply?.(); } catch { this.close(true); }
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) this.write(failureEnvelope(request.id, error instanceof ControlProtocolError ? error.code : '-32603'));
    }).finally(() => {
      clearTimeout(timer);
      // A timed-out request may already have been replaced; do not remove its successor.
      if (this.#pending.get(request.id)?.controller === controller) this.#pending.delete(request.id);
      if (request.method === 'control.initialize') this.#initializing = false;
    });
  }
  private async dispatch(request: MethodRequest, signal: AbortSignal): Promise<Reply> {
    if (request.method === 'control.initialize') {
      return { result: negotiateControl(request.params, { profileId: this.profileId, instanceId: this.instanceId,
        serviceVersion: this.options.version, implemented: { methods: ['control.initialize', 'control.cancelRequest', ...Object.keys(this.#handlers) as ControlMethod[]], events: this.options.events ?? [] } }) };
    }
    if (request.method === 'control.cancelRequest') {
      const pending = this.#pending.get(request.params.requestId);
      const cancellable = Boolean(pending && !pending.controller.signal.aborted);
      if (pending && cancellable) {
        pending.controller.abort(); clearTimeout(pending.timer);
        this.write(failureEnvelope(request.params.requestId, '-32010'));
      }
      return { result: { cancellationRequested: cancellable } };
    }
    const handler = this.#handlers[request.method];
    if (!handler) throw new ControlProtocolError('-32601');
    return handler(request, signal);
  }
  close(force = false): void {
    if (this.#closed) return;
    this.#closed = true; this.#lines.dispose();
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.controller.abort(); }
    this.#pending.clear(); this.#frames.length = 0; this.#queuedBytes = 0;
    this.options.input.off('data', this.onData).off('end', this.onEnd).off('error', this.onError).pause();
    this.options.output.off('drain', this.onDrain);
    for (const dispose of this.#disposers) { try { dispose(); } catch { /* No raw disposal errors on the control stream. */ } }
    this.#disposers.clear();
    const finish = (): void => { clearTimeout(deadline); this.#finish(); };
    const deadline = setTimeout(() => { this.options.output.destroy(); finish(); }, 1_000);
    this.options.output.once('finish', finish).once('close', finish);
    if (force) { this.options.output.destroy(); finish(); } else this.options.output.end();
  }
}
