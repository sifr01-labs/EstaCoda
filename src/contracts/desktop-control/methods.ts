import type {ConfiguredRouteReview} from './model-setup.js';
import type {OAuthStatus,OAuthBinding} from './model-setup.js';
import type {AuxiliaryList,AuxiliarySlot,AuxiliaryModeParams} from './model-setup.js';
import type {VerifyCandidateParams, CandidateVerification, ModelRouteDraft, ModelDraftBinding, ModelApplyReceipt, FallbackList, FallbackOrderParams} from './model-setup.js';
import type { BootstrapResult, Capabilities, ControlCursor, InitializeParams, InitializeResult } from "./bootstrap.js";
import type { ActivityProjection, ConnectionProjection, InboxProjection, ModelProjection, Page, ProviderProjection, TargetProjection, TargetReference, WorkProjection } from "./projections.js";

export type PageParams = { limit: number; cursor?: string };
export type SessionControl = { operationId: string; sessionId: string; target: TargetReference };
/** These acknowledge acceptance/settlement only; none proves an external effect occurred exactly once. */
export type OperationReceipt = {
  taskId?: string;
  operationId: string; profileId: string; sessionId: string; target: TargetReference;
  method: "tasks.create" | "sessions.setModel" | "tasks.setModel" | "tasks.pause" | "tasks.resume" | "tasks.cancel" | "tasks.retry" | "tasks.guide" | "sessions.start" | "sessions.resume" | "sessions.send" | "sessions.cancelTurn" | "approvals.resolve";
  state: "accepted" | "dispatched" | "completed" | "uncertain" | "unknown" | "expired";
  cancellation: "not_requested" | "requested" | "confirmed";
};
export type SubscribeParams = { after: ControlCursor; events: Capabilities["events"] };
export type SubscribeResult =
  | { state: "subscribed"; subscriptionId: string; cursor: ControlCursor }
  | { state: "snapshot_required"; reason: "instance_changed" | "stream_changed" | "cursor_expired" | "overflow" };
export type MethodContracts = {
  "tasks.create":{params:SessionControl&{taskId:string;objective:string;limits:{maxProviderCalls:number;maxTotalTokens:number;maxWallClockMs:number};selection:{providerId:string;modelId:string}|null};result:OperationReceipt};
  "work.live": {params:{workId:string};result:{active:boolean;turnId:string|null;text:string;truncated:boolean}};
  "work.targets": {params:Record<string,never>;result:{items:TargetProjection[];truncated:boolean}};
  "models.verifyDraft": {params:ModelDraftBinding&{spendApproved:true;allowPrivateEndpoint:boolean};result:CandidateVerification};
  "models.reviewConfigured": {params:ConfiguredRouteReview;result:ModelRouteDraft};
  "models.validateRoute": {params:{route:VerifyCandidateParams["route"]};result:{valid:true}};
  "models.refreshCatalog": {params:{networkApproved:true};result:{refreshed:boolean}};
  "models.oauthStart": {params:{windowId:string;generation:number};result:OAuthStatus};
  "models.oauthStatus": {params:OAuthBinding;result:OAuthStatus};
  "models.oauthCancel": {params:OAuthBinding;result:{cancelled:boolean}};
  "models.workOverride": {params:{sessionId:string;target:TargetReference;taskId?:string};result:{selection:{providerId:string;modelId:string}|null;effective:"next_turn"|"next_attempt"}};
  "sessions.setModel": {params:SessionControl & {selection:{providerId:string;modelId:string}|null};result:OperationReceipt};
  "tasks.setModel": {params:SessionControl & {taskId:string;selection:{providerId:string;modelId:string}|null};result:OperationReceipt};
  "models.auxiliary": {params:Record<string,never>;result:AuxiliaryList};
  "models.reviewAuxiliary": {params:Omit<VerifyCandidateParams,'spendApproved'>&{slot:AuxiliarySlot;fallbackToMain:boolean};result:ModelRouteDraft};
  "models.reviewAuxiliaryMode": {params:AuxiliaryModeParams;result:ModelRouteDraft};
  "models.fallbacks": {params:Record<string,never>;result:FallbackList};
  "models.reviewFallback": {params:Omit<VerifyCandidateParams,'spendApproved'>;result:ModelRouteDraft};
  "models.reviewFallbackOrder": {params:FallbackOrderParams;result:ModelRouteDraft};
  "models.reviewPrimary": {params: Omit<VerifyCandidateParams,'spendApproved'>;result:ModelRouteDraft};
  "models.applyDraft": {params:ModelDraftBinding;result:ModelApplyReceipt};
  "models.cancelDraft": {params:ModelDraftBinding;result:{cancelled:boolean}};
  "models.inspectApply": {params:{operationId?:string};result:ModelApplyReceipt};
  "models.verifyCandidate": {params: VerifyCandidateParams; result: CandidateVerification};
  "control.initialize": { params: InitializeParams; result: InitializeResult };
  "control.bootstrap": { params: Record<string, never>; result: BootstrapResult };
  "control.subscribe": { params: SubscribeParams; result: SubscribeResult };
  "control.unsubscribe": { params: { subscriptionId: string }; result: { removed: boolean } };
  "control.cancelRequest": { params: { requestId: string }; result: { cancellationRequested: boolean } };
  "work.list": { params: PageParams & { query?: string; parentWorkId?:string }; result: Page<WorkProjection> };
  "work.get": { params: { workId: string }; result: WorkProjection };
  "work.activity": { params: PageParams & { workId: string }; result: Page<ActivityProjection> };
  "inbox.list": { params: PageParams; result: Page<InboxProjection> };
  "models.list": { params: PageParams; result: Page<ModelProjection> };
  "providers.list": { params: PageParams; result: Page<ProviderProjection> };
  "connections.list": { params: PageParams; result: Page<ConnectionProjection> };
  "connections.get": { params: { connectionId: string }; result: ConnectionProjection };
  "tasks.pause": { params: SessionControl & { taskId: string }; result: OperationReceipt };
  "tasks.resume": { params: SessionControl & { taskId: string }; result: OperationReceipt };
  "tasks.cancel": { params: SessionControl & { taskId: string }; result: OperationReceipt };
  "tasks.retry": { params: SessionControl & { taskId: string; stepId?: string }; result: OperationReceipt };
  "tasks.guide": { params: SessionControl & { taskId: string; guidance: string }; result: OperationReceipt };
  "sessions.start": { params: SessionControl; result: OperationReceipt };
  "sessions.resume": { params: SessionControl; result: OperationReceipt };
  "sessions.send": { params: SessionControl & { text: string }; result: OperationReceipt };
  "sessions.cancelTurn": { params: SessionControl; result: OperationReceipt };
  "approvals.resolve": { params: SessionControl & { approvalId: string; decision: "approved" | "denied" }; result: OperationReceipt };
  "operations.inspect": { params: SessionControl & { taskId?: string; method: OperationReceipt["method"] }; result: OperationReceipt };
};
export type MethodRequest<M extends keyof MethodContracts = keyof MethodContracts> = M extends keyof MethodContracts
  ? { jsonrpc: "2.0"; id: string; method: M; params: MethodContracts[M]["params"] } : never;
export type MethodSuccess<M extends keyof MethodContracts> = { jsonrpc: "2.0"; id: string; result: MethodContracts[M]["result"] };
type EventBase = { profileId: string; subscriptionId: string; cursor: ControlCursor; timestamp: number };
export type ControlEvent = EventBase & (
  | { type: "control.ready"; payload: { state: "ready" } }
  | { type: "work.changed"; payload: WorkProjection }
  | { type: "activity.appended"; payload: ActivityProjection }
  | { type: "attention.changed"; payload: { item: InboxProjection | null; itemId: string } }
  | { type: "modelRoute.changed"; payload: ModelProjection }
  | { type: "connection.changed"; payload: ConnectionProjection }
  | { type: "service.warning"; payload: { reason: "resync_required" | "runtime_unavailable" | "configuration_changed" } }
  | { type: "service.shutdown"; payload: { reason: "client_closed" | "profile_changed" | "service_restart" } }
);
export type EventNotification = { jsonrpc: "2.0"; method: "control.event"; params: ControlEvent };
