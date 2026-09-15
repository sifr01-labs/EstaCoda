import {DesktopSecureInput} from './desktop-secure-input.js';
import type { GatewayApprovalQueue } from './approval-queue.js';
import { validPendingAction } from '../security/pending-action-approval.js';
import { redactSensitiveText } from '../utils/redaction.js';
import type { ControlReceipts } from "./control-receipts.js";
import { randomUUID } from "node:crypto";
import type { SessionDB } from "../contracts/session.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { ToolApprovalRequest } from "../contracts/tool.js";
import { SessionCompressionLock } from "../session/session-compression-lock.js";
import type { PrivateControlRequest } from "./private-control.js";

type Active = { preview?:{turnId:string;text:string;truncated:boolean}; controller: AbortController; pending?: { durable?: boolean; id: string; request: ToolApprovalRequest; resolve(value: "approved" | "denied"): void }; runtime?: Runtime };
/** Transport detach never aborts hosted execution. Normal inputs serialize by
 * Session; operator controls do not join that queue. */
export class SharedSessionHost {
  readonly #secureInput:DesktopSecureInput;
  readonly #cancelGeneration = new Map<string, number>();
  readonly #active = new Map<string, Active>();
  readonly #turns = new Set<Promise<unknown>>();
  readonly #serial = new SessionCompressionLock();
  readonly #connectorReloads = new Set<string>();
  readonly #connectorFailures = new Set<string>();
  #closed = false;
  constructor(readonly options: {
    resolveMedia?(request:PrivateControlRequest):Promise<import('../contracts/channel.js').ChannelAttachment[]>;
    profileId: string; sessionDb: SessionDB; receipts?: ControlReceipts;
    approvalQueue?: GatewayApprovalQueue;
    inspectConnectors?(sessionId: string): import("../mcp/mcp-tools.js").MCPServerSnapshot[] | undefined;
    browserControl?(request:PrivateControlRequest):Promise<unknown>;
    modelControl?(request: PrivateControlRequest): Promise<unknown>;
    taskControl?(request: PrivateControlRequest): unknown;
    validateTarget?(request: PrivateControlRequest): Promise<void>;
    acquire(sessionId: string): Promise<Runtime>;
    channelCancel?(sessionId: string): boolean | Promise<boolean>;
    channelApproval(request: PrivateControlRequest): Promise<unknown>;
  }) {this.#secureInput=new DesktopSecureInput(options.profileId);}
  async validate(request: PrivateControlRequest, allowEnded = false): Promise<void> {
    if (this.#closed) throw new Error("Shared host is draining.");
    const session = await this.options.sessionDb.getSessionForProfile(request.sessionId, this.options.profileId);
    if(request.method==='inspect'&&request.targetGeneration!==undefined&&session?.executionTarget?.targetGeneration!==request.targetGeneration)throw new Error('Shared Session target generation does not match.');
    const durableApproval = request.method === 'approval' && request.targetGeneration !== undefined && !allowEnded
      ? await this.options.approvalQueue?.getApproval(request.approvalId!, { profileId: this.options.profileId, sessionId: request.sessionId }) : undefined;
    if (request.method === 'approval' && request.targetGeneration !== undefined && !allowEnded &&
      (!durableApproval || durableApproval.status !== 'pending' || durableApproval.expiresAt.getTime() <= Date.now())) throw new Error('Approval is not pending in this Session.');
    if (request.targetGeneration !== undefined && request.method !== "inspect" && !allowEnded) {
      if (session?.executionTarget?.targetGeneration !== request.targetGeneration || !this.options.validateTarget) throw new Error("Shared Session target generation does not match.");
      await this.options.validateTarget(request);
    }
    if (!session || (session.endedAt && !allowEnded && !request.method.startsWith("task.") && durableApproval?.approvalKind !== "task") || session.executionTarget?.targetId !== request.targetId) throw new Error("Shared Session target does not match.");
  }
  async handle(request: PrivateControlRequest): Promise<unknown> {
    const receipts = this.options.receipts;
    await this.validate(request, request.method === "inspect" || (receipts?.inspect(request).length ?? 0) > 0);
    if(request.method==='mcp.control'||request.method==='browser.control'||request.method==='secure.input'){
      const execution=this.execute(request);this.#controls.add(execution);
      try{return await execution;}finally{this.#controls.delete(execution);}
    }
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
    let generation = this.#cancelGeneration.get(request.sessionId) ?? 0;
    await this.validate(request, request.method === "inspect");
    if(request.method==='mcp.control')return this.connectorControl(request);
    if(request.method==='send'&&request.text?.trim()==='/reload-mcp'){
      if(request.mediaIds?.length)throw new Error('Reconnect does not accept attachments.');
      return this.connectorControl({...request,connectorAction:'reconnect'});
    }
    if(request.method==='secure.input')return this.#secureInput.handle({sessionId:request.sessionId,targetId:request.targetId,targetGeneration:request.targetGeneration!},request.workInput!);
    if(request.method==='browser.control'){if(!this.options.browserControl)throw new Error('Browser controls unavailable.');return this.options.browserControl(request);}
    const active = this.#active.get(request.sessionId);
    if (request.method === "inspect") return { active: Boolean(active), preview:active?.preview?{...active.preview,text:redactSensitiveText(active.preview.text)}:undefined, approval: active?.pending ? {
      id: active.pending.id, tool: active.pending.request.tool.name,
      riskClass: active.pending.request.riskClass, targetSummary: active.pending.request.targetSummary,
    } : undefined };
    if (request.method === "model" || request.method === "task.model") {
      if (!this.options.modelControl) throw new Error("Model controls unavailable.");
      if (this.#turns.size >= 128) throw new Error("Shared input queue is full.");
      const change = this.#serial.runExclusive(request.sessionId, async () => {
        await this.validate(request);
        return this.options.modelControl!(request);
      });
      this.#turns.add(change);
      try { return await change; } finally { this.#turns.delete(change); }
    }
    if (request.method.startsWith("task.")) {
      if (!this.options.taskControl) throw new Error("Task operator controls unavailable.");
      return this.options.taskControl(request);
    }
    if (request.method === "start" || request.method === "resume") return { sessionId: request.sessionId };
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
        // Claim before awaiting: a second resolution must not grant or resume twice.
        active.pending = undefined;
        try {
          if (pending.durable) {
            await this.options.approvalQueue!.resolveApproval(pending.id, request.decision!, 'desktop-operator', {
              profileId: this.options.profileId, sessionId: request.sessionId });
            return { resolved: true };
          }
        if (request.decision === "approved") await active.runtime!.grantApproval!({
          pendingApproval: pending.request.pendingApproval, toolName: pending.request.tool.name,
          riskClass: pending.request.riskClass, targetKey: pending.request.targetKey,
          targetSummary: pending.request.targetSummary, scope: "once"
        });
          pending.resolve(request.decision!);
        } catch (error) { pending.resolve('denied'); throw error; }
        return { resolved: true };
      }
      return this.options.channelApproval(request);
    }
    if (this.#turns.size >= 128) throw new Error("Shared input queue is full.");
    if(request.interrupt){
      // Validate before cancellation. The replacement joins the same serial queue,
      // so no new tools start until the interrupted turn has actually settled.
      generation=(this.#cancelGeneration.get(request.sessionId)??0)+1;
      this.#cancelGeneration.set(request.sessionId,generation);
      active?.controller.abort();active?.pending?.resolve('denied');
      await this.options.channelCancel?.(request.sessionId);
    }
    const turn = this.#serial.runExclusive(request.sessionId, async () => {
      await this.validate(request);
      if (generation !== (this.#cancelGeneration.get(request.sessionId) ?? 0)) throw new Error("Queued input was cancelled.");
      const state: Active = { controller: new AbortController(),preview:{turnId:request.operationId,text:'',truncated:false} };
      this.#active.set(request.sessionId, state);
      let previousSecurityMode:ReturnType<NonNullable<Runtime['securityMode']>>|undefined;
      try {
        state.runtime = await this.options.acquire(request.sessionId);
        if(request.securityMode){
          previousSecurityMode=state.runtime.securityMode?.();
          if(!previousSecurityMode||!state.runtime.setSecurityMode)throw new Error('Conversation permissions unavailable.');
          state.runtime.setSecurityMode(request.securityMode);
        }
        const attachments=request.mediaIds?.length?await this.options.resolveMedia?.(request):undefined;if(request.mediaIds?.length&&!attachments)throw new Error('Media resolver unavailable');
        const onSecureInputRequest=request.targetGeneration===undefined?undefined:state.runtime.createSecureInputRequestHandler?.({collect:this.#secureInput.collector({sessionId:request.sessionId,targetId:request.targetId,targetGeneration:request.targetGeneration}),signal:state.controller.signal});
        const response = await state.runtime.handle({onSecureInputRequest,attachments, text: request.text!, channel: "cli", signal: state.controller.signal,
          onDelta: text=>{if(!state.preview)return;const combined=state.preview.text+text;state.preview.truncated ||= combined.length>16384;state.preview.text=combined.slice(0,16384);},
          onEvent: event=>{if(event.kind==='provider-tool-call'&&state.preview){state.preview.text='';state.preview.truncated=false;}},
          onApprovalRequest: async (approval) => {
            if (state.controller.signal.aborted) return 'denied';
            let id: string = randomUUID(); let durable = false;
            const queue = this.options.approvalQueue;
            if (request.targetGeneration !== undefined) {
              if (!queue || !validPendingAction(approval.pendingApproval)) return 'denied';
              const pending = await queue.createPendingApproval({
                profileId: this.options.profileId, sessionId: request.sessionId, channel: 'desktop',
                toolName: approval.tool.name, commandPreview: redactSensitiveText(approval.targetSummary ?? approval.tool.name).slice(0, 2048),
                commandPayload: typeof approval.input.command === 'string' ? approval.input.command : undefined,
                commandHash: approval.pendingApproval.actionKey, executionApproval: approval.pendingApproval,
                desktopBinding: { targetId: request.targetId, targetGeneration: request.targetGeneration, riskClass: approval.riskClass },
                requestedAt: new Date(), expiresAt: new Date(approval.pendingApproval.expiresAt),
              });
              if (pending.status !== 'pending') return 'denied';
              id = pending.id; durable = true;
              if (state.controller.signal.aborted) {
                await queue.resolveApproval(id, 'denied', 'owner-cancelled', { profileId: this.options.profileId, sessionId: request.sessionId });
                return 'denied';
              }
            }
            if (durable) {
              const scope = { profileId: this.options.profileId, sessionId: request.sessionId };
              state.pending = { id, durable, request: approval, resolve: (decision) => {
                void queue!.resolveApproval(id, decision, 'owner-cancelled', scope).catch(() => undefined);
              } };
              try {
                const result = await queue!.waitForResolution(id, scope);
                if (result.status !== 'approved' || state.controller.signal.aborted) return 'denied';
                await this.validate(request);
                if (!state.runtime?.grantApproval) return 'denied';
                await state.runtime.grantApproval({ pendingApproval: approval.pendingApproval, toolName: approval.tool.name,
                  riskClass: approval.riskClass, targetKey: approval.targetKey, targetSummary: approval.targetSummary, scope: 'once' });
                return 'approved';
              } finally { if (state.pending?.id === id) state.pending = undefined; }
            }
            return new Promise((resolve) => { state.pending = { id, request: approval, resolve }; });
          } });
        return { text: response.text, sessionId: state.runtime.sessionId };
      } finally {
        state.controller.abort();
        if (state.pending?.durable) await this.options.approvalQueue!.resolveApproval(state.pending.id, 'denied', 'owner-settled', {
          profileId: this.options.profileId, sessionId: request.sessionId }).catch(() => undefined);
        state.pending?.resolve("denied");
        this.#active.delete(request.sessionId);
        if(previousSecurityMode)state.runtime?.setSecurityMode?.(previousSecurityMode);
        await state.runtime?.dispose();
      }
    });
    this.#turns.add(turn);
    try { return await turn; } finally { this.#turns.delete(turn); }
  }
  private connectorControl(request: PrivateControlRequest) {
    const sessionId = request.sessionId;
    const snapshot = () => ({
      state: this.#connectorReloads.has(sessionId) ? 'reconnecting' : this.#active.has(sessionId) ? 'busy' : this.#connectorFailures.has(sessionId) ? 'failed' : 'ready',
      servers: this.options.inspectConnectors?.(sessionId) ?? null
    });
    if (request.connectorAction === 'inspect' || this.#connectorReloads.has(sessionId)) return snapshot();
    if (this.#active.has(sessionId)) return { ...snapshot(), state: 'busy' };
    if (this.#turns.size >= 128 || this.#connectorReloads.size >= 128) throw new Error('Connector control is busy.');
    this.#connectorReloads.add(sessionId);
    this.#connectorFailures.delete(sessionId);
    const reconnect = this.#serial.runExclusive(sessionId, async () => {
      await this.validate(request);
      const alreadyLoaded = this.options.inspectConnectors?.(sessionId) !== undefined;
      const runtime = await this.options.acquire(sessionId);
      try {
        if (!runtime.reconnectMcpServers) throw new Error('Connector reconnect unavailable.');
        if (alreadyLoaded) await runtime.reconnectMcpServers();
      } finally { await runtime.dispose(); }
    }).catch(() => {
      // Bounded, content-free diagnostic. Connection errors stay out of the renderer.
      if (this.#connectorFailures.size >= 128) this.#connectorFailures.delete(this.#connectorFailures.values().next().value!);
      this.#connectorFailures.add(sessionId);
    }).finally(() => { this.#connectorReloads.delete(sessionId); this.#controls.delete(reconnect); });
    this.#controls.add(reconnect);
    return snapshot();
  }
  hasPendingWork(): boolean { return this.#turns.size > 0 || this.#controls.size > 0; }
  async close(): Promise<void> {
    this.#closed = true;this.#secureInput.close();
    for (const active of this.#active.values()) { active.controller.abort(); active.pending?.resolve("denied"); }
    await Promise.allSettled([...this.#turns, ...this.#controls]);
  }
}
