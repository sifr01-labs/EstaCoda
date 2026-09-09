import type { SessionDB } from "../contracts/session.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SessionExecutionOwnership, type ExecutionClaim } from "../session/execution-ownership.js";
import { withExecutionFence, rotateExecutionFence } from "../session/execution-fence-context.js";
import { SessionCompressionLock } from "../session/session-compression-lock.js";

/** One runtime owns its Session until settled disposal. Child runtimes acquire
 * distinct claims after Task host/Attempt admission and before their first turn. */
export class RuntimeSessionOwner {
  readonly #store?: SessionExecutionOwnership;
  #claim?: ExecutionClaim;
  readonly #retiredClaims: ExecutionClaim[] = [];
  readonly #serial = new SessionCompressionLock();
  readonly #controller = new AbortController();
  #closed = false;
  #active?: Promise<unknown>;
  private constructor(readonly db: SessionDB) {
    if (db instanceof SQLiteSessionDB) this.#store = new SessionExecutionOwnership(db.db);
  }
  static async acquire(db: SessionDB, sessionId: string, profileId: string): Promise<RuntimeSessionOwner> {
    const owner = new RuntimeSessionOwner(db);
    if (owner.#store) {
      const session = await db.getSessionForProfile(sessionId, profileId);
      if (!session?.executionTarget) throw new Error("Execution requires an established Session target.");
      owner.#claim = owner.#store.claim({ sessionId, profileId, targetId: session.executionTarget.targetId });
    }
    return owner;
  }
  get signal(): AbortSignal { return this.#controller.signal; }
  assert(): void {
    if (this.#closed || this.signal.aborted) throw new Error("Session execution owner is closed.");
    if (this.#claim) this.#store!.assert(this.#claim);
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    return this.#serial.runExclusive("turn", async () => {
      this.assert();
      if (this.#claim) this.#store!.advance(this.#claim, "turn");
      const timer = setInterval(() => {
        try { if (this.#claim) this.#store!.renew(this.#claim); }
        catch (error) { this.#controller.abort(error); }
      }, 10_000);
      timer.unref?.();
      const running = Promise.resolve().then(() => this.#claim
        ? withExecutionFence(this.#store!.db, this.#claim, work) : work());
      this.#active = running;
      try { const result = await running; this.assert(); return result; }
      finally { clearInterval(timer); this.#active = undefined; }
    });
  }
  rotate(sessionId: string): void {
    if (!this.#claim || this.#claim.sessionId === sessionId) return;
    this.assert();
    const next = this.#store!.claim({ sessionId, profileId: this.#claim.profileId, targetId: this.#claim.targetId });
    this.#retiredClaims.push(this.#claim);
    this.#claim = next;
    rotateExecutionFence(this.#store!.db, next);
  }
  cancel(): void { this.#controller.abort(new Error("Session execution cancelled.")); }
  async settle(): Promise<void> {
    this.#closed = true; this.cancel();
    await this.#active?.catch(() => undefined);
  }
  release(): void {
    for (const claim of this.#retiredClaims) this.#store!.release(claim);
    this.#retiredClaims.length = 0;
    if (this.#claim) { this.#store!.release(this.#claim); this.#claim = undefined; }
  }
}
