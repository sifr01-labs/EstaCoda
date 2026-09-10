import { validateSessionWorkspaceOwnership } from "../session/session-workspace-ownership.js";
import { withExecutionAuthority } from "./live-execution-authority.js";
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
  readonly #operations = new Set<Promise<unknown>>();
  #validator: () => Promise<void> = async () => undefined;
  #stop?: () => Promise<void>;
  #watchdog?: ReturnType<typeof setInterval>;
  readonly #authorityChecks = new Set<() => void | Promise<void>>();
  setValidator(check: () => Promise<void>, stop?: () => Promise<void>): void {
    this.#validator = check; this.#stop = stop;
    let checking = false;
    this.#watchdog = setInterval(() => {
      if (checking || this.#closed || this.signal.aborted) return;
      checking = true;
      void this.validate().catch(() => this.cancel()).finally(() => { checking = false; });
    }, 1000);
    this.#watchdog.unref?.();
  }
  async validate(): Promise<void> {
    this.assert(); await this.#validator();
    if (this.#claim && this.targetContext) {
      const session = await this.db.getSessionForProfile(this.#claim.sessionId, this.#claim.profileId);
      if (!session) throw new Error("Session execution target is unavailable.");
      await validateSessionWorkspaceOwnership({ session, profileId: this.#claim.profileId, ...this.targetContext });
    }
    for (const check of this.#authorityChecks) await check();
    this.assert();
  }
  private constructor(readonly db: SessionDB, readonly targetContext?: { workspaceRoot: string; homeDir?: string }) {
    if (db instanceof SQLiteSessionDB) this.#store = new SessionExecutionOwnership(db.db);
  }
  static async acquire(db: SessionDB, sessionId: string, profileId: string, targetContext?: { workspaceRoot: string; homeDir?: string }): Promise<RuntimeSessionOwner> {
    const owner = new RuntimeSessionOwner(db, targetContext);
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
      await this.validate();
      if (this.#claim) this.#store!.advance(this.#claim, "turn");
      const timer = setInterval(() => {
        try { if (this.#claim) this.#store!.renew(this.#claim); }
        catch { this.cancel(); }
      }, 10_000);
      timer.unref?.();
      const running = Promise.resolve().then(() => withExecutionAuthority(() => this.validate(), this.#authorityChecks, () => this.#claim
        ? withExecutionFence(this.#store!.db, this.#claim, work, () => this.assert()) : work(), (operation) => {
          this.#operations.add(operation);
          void operation.finally(() => this.#operations.delete(operation)).catch(() => undefined);
        }));
      this.#active = running;
      try { const result = await running; await this.validate(); return result; }
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
  cancel(): void {
    this.#controller.abort(new Error("Session execution cancelled or authority revoked."));
    if (this.#watchdog) clearInterval(this.#watchdog);
    void this.#stop?.().catch(() => undefined);
  }
  async settle(): Promise<void> {
    this.#closed = true; this.cancel();
    await this.#active?.catch(() => undefined);
    await this.#stop?.();
    while (this.#operations.size) await Promise.allSettled([...this.#operations]);
  }
  release(): void {
    if (this.#watchdog) clearInterval(this.#watchdog);
    for (const claim of this.#retiredClaims) this.#store!.release(claim);
    this.#retiredClaims.length = 0;
    if (this.#claim) { this.#store!.release(this.#claim); this.#claim = undefined; }
  }
}
