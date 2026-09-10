import type { ControlReceipts } from "./control-receipts.js";
import { randomUUID } from "node:crypto";
import type { SessionDB } from "../contracts/session.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { ToolApprovalRequest } from "../contracts/tool.js";
import { SessionCompressionLock } from "../session/session-compression-lock.js";
import type { PrivateControlRequest } from "./private-control.js";

type Active = { controller: AbortController; pending?: { id: string; request: ToolApprovalRequest; resolve(value: "approved" | "denied"): void }; runtime?: Runtime };
/** Transport detach never aborts hosted execution. Normal inputs serialize by
 * Session; operator controls do not join that queue. */
export class SharedSessionHost {
  readonly #cancelGeneration = new Map<string, number>();
  readonly #active = new Map<string, Active>();
  readonly #turns = new Set<Promise<unknown>>();
  readonly #serial = new SessionCompressionLock();
  #closed = false;
  constructor(readonly options: {
    profileId: string; sessionDb: SessionDB; receipts?: ControlReceipts;
    acquire(sessionId: string): Promise<Runtime>;
    channelCancel?(sessionId: string): boolean | Promise<boolean>;
    channelApproval(request: PrivateControlRequest): Promise<unknown>;
  }) {}
  async validate(request: PrivateControlRequest, allowEnded = false): Promise<void> {
    if (this.#closed) throw new Error("Shared host is draining.");
    const session = await this.options.sessionDb.getSessionForProfile(request.sessionId, this.options.profileId);
    if (!session || (session.endedAt && !allowEnded) || session.executionTarget?.targetId !== request.targetId) throw new Error("Shared Session target does not match.");
  }
  async handle(request: PrivateControlRequest): Promise<unknown> {
    const receipts = this.options.receipts;
    await this.validate(request, request.method === "inspect" || (receipts?.inspect(request).length ?? 0) > 0);
    if (!receipts) return this.execute(request);
    if (request.method === "inspect") return { receipts: receipts.inspect(request), execution: await this.execute(request) };
    const accepted = receipts.accept(request);
    if (accepted.inserted) {
      receipts.transition(request, "dispatched");
      const execution = this.execute(request).then((result) => {
        receipts.transition(request, "completed", request.method === "send" ? { sessionId: request.sessionId, response: "session-transcript" } : result);
      }, () => { receipts.transition(request, "uncertain"); });
      // Detached from the socket, but owned by supervisor shutdown.
      this.#controls.add(execution);
      void execution.finally(() => this.#controls.delete(execution)).catch(() => undefined);
    }
    return accepted.receipt;
  }
  readonly #controls = new Set<Promise<unknown>>();
  private async execute(request: PrivateControlRequest): Promise<unknown> {
    const generation = this.#cancelGeneration.get(request.sessionId) ?? 0;
    await this.validate(request, request.method === "inspect");
    const active = this.#active.get(request.sessionId);
    if (request.method === "inspect") return { active: Boolean(active), approval: active?.pending ? {
      id: active.pending.id, tool: active.pending.request.tool.name,
      riskClass: active.pending.request.riskClass, targetSummary: active.pending.request.targetSummary,
    } : undefined };
    if (request.method === "cancel") {
      this.#cancelGeneration.set(request.sessionId, generation + 1);
      active?.controller.abort(); active?.pending?.resolve("denied");
      const channelCancelled = await this.options.channelCancel?.(request.sessionId) ?? false;
      // Absence from this map cannot prove a foreign owner or OS process settled.
      return { cancellationRequested: Boolean(active) || channelCancelled, terminationConfirmed: false };
    }
    if (request.method === "approval") {
      if (active && active.pending && active.pending.id === request.approvalId) {
        const pending = active.pending;
        if (request.decision === "approved") await active.runtime!.grantApproval!({
          pendingApproval: pending.request.pendingApproval, toolName: pending.request.tool.name,
          riskClass: pending.request.riskClass, targetKey: pending.request.targetKey,
          targetSummary: pending.request.targetSummary, scope: "once"
        });
        active.pending = undefined; pending.resolve(request.decision!);
        return { resolved: true };
      }
      return this.options.channelApproval(request);
    }
    if (this.#turns.size >= 128) throw new Error("Shared input queue is full.");
    const turn = this.#serial.runExclusive(request.sessionId, async () => {
      await this.validate(request);
      if (generation !== (this.#cancelGeneration.get(request.sessionId) ?? 0)) throw new Error("Queued input was cancelled.");
      const state: Active = { controller: new AbortController() };
      this.#active.set(request.sessionId, state);
      try {
        state.runtime = await this.options.acquire(request.sessionId);
        const response = await state.runtime.handle({ text: request.text!, channel: "cli", signal: state.controller.signal,
          onApprovalRequest: (approval) => new Promise((resolve) => {
            if (state.controller.signal.aborted) { resolve("denied"); return; }
            state.pending = { id: randomUUID(), request: approval, resolve };
          }) });
        return { text: response.text, sessionId: state.runtime.sessionId };
      } finally {
        state.pending?.resolve("denied");
        this.#active.delete(request.sessionId);
        await state.runtime?.dispose();
      }
    });
    this.#turns.add(turn);
    try { return await turn; } finally { this.#turns.delete(turn); }
  }
  hasPendingWork(): boolean { return this.#turns.size > 0 || this.#controls.size > 0; }
  async close(): Promise<void> {
    this.#closed = true;
    for (const active of this.#active.values()) { active.controller.abort(); active.pending?.resolve("denied"); }
    await Promise.allSettled([...this.#turns, ...this.#controls]);
  }
}
