import type { ControlEvent } from '../contracts/desktop-control/index.js';
import type { BootstrapState } from './bridge.js';
export type RuntimeNotification = Pick<Extract<ControlEvent, { type: 'service.warning' }>, 'type' | 'payload'>;
/** Select fixed guidance only: never forward configuration, provider errors or host bodies. */
export function projectRuntimeChange(previous: BootstrapState, current: BootstrapState): RuntimeNotification | undefined {
  if (previous.profile.id !== current.profile.id) throw new Error('Runtime observation crossed profiles.');
  if (previous.profile.configuration !== current.profile.configuration) return { type: 'service.warning', payload: { reason: 'configuration_changed' } };
  if (previous.runtime.state !== current.runtime.state) return { type: 'service.warning', payload: { reason: 'resync_required' } };
  return undefined;
}
/** Until core offers push status, perform one bounded read at a time. Closing the bridge cancels the observer, not the host. */
export class RuntimeStateMonitor {
  #state: BootstrapState;
  #closed = false;
  #polling = false;
  #controller = new AbortController();
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(initial: BootstrapState, readonly read: (signal: AbortSignal) => Promise<BootstrapState>, readonly publish: (event: RuntimeNotification) => void, intervalMs = 5_000) {
    this.#state = structuredClone(initial);
    this.#timer = setInterval(() => { void this.poll(); }, intervalMs); this.#timer.unref();
  }
  async poll(): Promise<void> {
    if (this.#closed || this.#polling) return;
    this.#polling = true;
    const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(3_000)]);
    try {
      let next: BootstrapState;
      try { next = await this.read(signal); signal.throwIfAborted(); }
      catch { next = { profile: this.#state.profile, runtime: { state: 'disconnected' } }; }
      if (this.#closed) return;
      const projected = projectRuntimeChange(this.#state, next);
      this.#state = structuredClone(next);
      if (projected) this.emit(projected);
    } catch {
      // Invalid observation cannot overwrite the last known profile or become an exception payload.
      if (!this.#closed) this.emit({ type: 'service.warning', payload: { reason: 'runtime_unavailable' } });
    } finally { this.#polling = false; }
  }
  private emit(event: RuntimeNotification): void { try { this.publish(event); } catch { this.dispose(); } }
  dispose(): void { this.#closed = true; clearInterval(this.#timer); this.#controller.abort(); }
}
