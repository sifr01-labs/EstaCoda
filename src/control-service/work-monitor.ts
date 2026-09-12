import type { WorkState } from './work-snapshot.js';
import type { SafeNotification } from './subscriptions.js';
/** Polls canonical state without owning execution. Bounded journal/backpressure remain downstream. */
export class WorkMonitor {
  #previous: WorkState;
  #running = false;
  #disposed = false;
  #abort = new AbortController();
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(initial: WorkState, readonly read: (signal: AbortSignal) => Promise<WorkState>, readonly publish: (event: SafeNotification) => void) {
    this.#previous = structuredClone(initial);
    this.#timer = setInterval(() => { void this.tick(); }, 5_000); this.#timer.unref();
  }
  async tick(): Promise<void> {
    if (this.#disposed || this.#running) return;
    this.#running = true;
    try {
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(3_000)]);
      const next = await this.read(signal);
      signal.throwIfAborted();
      if (this.#disposed) return;
      const oldWork = new Map(this.#previous.work.map((work) => [work.id, JSON.stringify(work)]));
      for (const work of next.work) if (oldWork.get(work.id) !== JSON.stringify(work)) this.publish({ type: 'work.changed', payload: work });
      const oldInbox = new Map((this.#previous.inbox ?? []).map((item) => [item.id, JSON.stringify(item)]));
      for (const item of next.inbox ?? []) {
        if (oldInbox.get(item.id) !== JSON.stringify(item)) this.publish({ type: 'attention.changed', payload: { itemId: item.id, item } });
        oldInbox.delete(item.id);
      }
      for (const itemId of oldInbox.keys()) this.publish({ type: 'attention.changed', payload: { itemId, item: null } });
      let resync = this.#previous.activeSchedules!==next.activeSchedules || Object.keys(this.#previous.activity).some((id) => !Object.hasOwn(next.activity, id)) || this.#previous.work.some((old) => !next.work.some((work) => work.id === old.id));
      for (const [workId, boundary] of Object.entries(next.history ?? {})) {
        const previous = this.#previous.history?.[workId];
        if (previous && (previous.revision !== boundary.revision ||
          ((!next.activity[workId] || !this.#previous.activity[workId]) && JSON.stringify(previous) !== JSON.stringify(boundary)))) resync = true;
      }
      for (const [workId, activity] of Object.entries(next.activity)) {
        const previous = new Map((this.#previous.activity[workId] ?? []).map((item) => [item.id, JSON.stringify(item)]));
        for (const item of activity) {
          if (!previous.has(item.id)) this.publish({ type: 'activity.appended', payload: item });
          else if (previous.get(item.id) !== JSON.stringify(item)) resync = true;
          previous.delete(item.id);
        }
        if (previous.size) resync = true;
      }
      if (resync) this.publish({ type: 'service.warning', payload: { reason: 'resync_required' } });
      this.#previous = structuredClone(next);
    } catch { if (!this.#disposed) this.publish({ type: 'service.warning', payload: { reason: 'resync_required' } }); }
    finally { this.#running = false; }
  }
  dispose(): void { this.#disposed = true; this.#abort.abort(); clearInterval(this.#timer); }
}
