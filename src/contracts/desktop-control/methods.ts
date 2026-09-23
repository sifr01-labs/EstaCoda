import type {TargetDetails,TargetInspection,TargetCreationReview,TargetOperation} from './targets.js';
import type {TelegramSession,TelegramSessionDetails} from './telegram.js';
import type {TelegramOperationAction,TelegramPairing} from './telegram.js';
import type {ConnectionOperation,GatewayAction,GatewayDiagnostics} from './telegram.js';
import type {TelegramSettings,TelegramDraft,TelegramReview,TelegramVerify,TelegramVerification} from './telegram.js';
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
export type WorkUsageProjection={scope:'session'|'task'|'attempt';reportedTokens:number|null;providerCalls:number;cost:{amount:number;currency:'USD'}|null;usageComplete:boolean;pricingComplete:boolean;context:{usedTokens:number;totalTokens:number;provider:string;model:string}|null;truncated:boolean;provisional:boolean};
export type RuntimeCounts={runningSessions:number;runningTasks:number;queuedTasks:number;approvals:number;attention:number;scheduled:number|null;asOf:number};
export type MethodContracts = {
  'setup.local':{params:Record<string,never>;result:import('./onboarding.js').LocalSetupInspection};
  'connections.connectors': { params: { action: 'inspect' | 'reconnect'; workId?: string }; result: import('./connectors.js').ConnectorStatus };
 'schedules.draft':{params:{id:string};result:import('./schedules.js').ScheduleDraft};
 'schedules.review':{params:import('./schedules.js').ScheduleAction;result:import('./schedules.js').ScheduleReview};
 'schedules.cancel':{params:{reviewId:string};result:{cancelled:boolean}};
 'schedules.execute':{params:{reviewId:string;operationId:string;confirmed:true};result:ConnectionOperation};
 'schedules.inspect':{params:{operationId:string};result:ConnectionOperation};
 'schedules.list':{params:{offset?:number};result:{items:import('./schedules.js').ScheduleProjection[];nextOffset:number|null}};
 'schedules.get':{params:{id:string};result:import('./schedules.js').ScheduleProjection};
 'schedules.history':{params:{id:string;offset?:number};result:{items:import('./schedules.js').ScheduleExecutionProjection[];nextOffset:number|null;available:boolean}};
 'evolution.review':{params:{proposalId:string;action:import('./library.js').EvolutionAction;target?:TargetReference};result:import('./library.js').EvolutionReview};
 'evolution.cancel':{params:{reviewId:string};result:{cancelled:boolean}};
 'evolution.execute':{params:{reviewId:string;operationId:string;confirmed:true};result:ConnectionOperation};
 'evolution.inspect':{params:{operationId:string};result:ConnectionOperation};
 'library.proposals':{params:{offset?:number};result:{items:import('./library.js').LibraryProposal[];nextOffset:number|null}};
 'library.proposal':{params:{id:string};result:import('./library.js').LibraryProposalDetail};
 'library.skills':{params:{offset?:number};result:{items:import('./library.js').LibrarySkill[];nextOffset:number|null}};
 'library.skill':{params:{id:string};result:import('./library.js').LibrarySkillDetail};
 'library.memory':{params:Record<string,never>;result:{items:import('./library.js').LibraryMemory[]}};
 'setup.verify':{params:{alias?:string};result:import('./onboarding.js').OnboardingVerification};
 'setup.review':{params:{model:ModelDraftBinding;optional?:import('./settings.js').SettingsBinding;preferences:import('./settings.js').SettingChange[];workspaceReviewId:string};result:import('./onboarding.js').OnboardingReview};
 'setup.apply':{params:{reviewId:string;confirmed:true};result:{operationId:string;state:'applied'|'uncertain'|'unknown'}};
 'setup.recover':{params:Record<string,never>;result:{operationId:string;state:'applied'|'uncertain'|'unknown'}};
 'setup.reviewWorkspace':{params:{path:string;alias:string;trust:boolean};result:import('./onboarding.js').OnboardingWorkspaceReview};
 'setup.applyWorkspace':{params:{reviewId:string;operationId:string;confirmed:true};result:ConnectionOperation};
 'setup.cancelWorkspace':{params:{reviewId:string};result:{cancelled:boolean}};
 'setup.detect':{params:Record<string,never>;result:import('./onboarding.js').SetupDetection};
 'setup.bootstrap':{params:Record<string,never>;result:import('./onboarding.js').SetupDetection};
 'artifacts.mediaBegin':{params:{reference:import('./artifacts.js').ArtifactReference};result:{transferId:string;bytes:number;mimeType:string;sha256:string;name:string}};
 'artifacts.mediaChunk':{params:{transferId:string;offset:number};result:{data:string}};
 'artifacts.mediaClose':{params:{transferId:string};result:{closed:boolean}};

 'media.stage':{params:{path:string;target:TargetReference};result:{id:string;name:string;size:number;type:string}};

 'settings.workspaces':{params:{};result:{items:import('./settings.js').SettingsWorkspace[];truncated:boolean}};
 'settings.reviewAction':{params:import('./settings.js').SettingsAction;result:import('./settings.js').SettingsActionReview};
 'settings.executeAction':{params:{reviewId:string;operationId:string;confirmed:true};result:ConnectionOperation};
 'settings.cancelAction':{params:{reviewId:string};result:{cancelled:boolean}};

 "settings.lifecycle":{params:Record<string,never>;result:{version:string;owner:string;update:"owner_required";uninstall:"owner_required"}};
 "settings.dependencies":{params:Record<string,never>;result:import('./settings.js').SettingsDependenciesPage};
 "settings.installDependency":{params:{operationId:string;capabilityId:string;groups:string[];downloadApproved:true};result:ConnectionOperation};
 "settings.inspectDependency":{params:{operationId:string};result:ConnectionOperation};
  "settings.apply":{params:import('./settings.js').SettingsBinding;result:{operationId:string;state:'applied'|'uncertain'|'unknown'}};
  "settings.inspect":{params:{operationId?:string};result:{operationId:string;state:'applied'|'uncertain'|'unknown'}};
  "settings.verify":{params:Record<string,never>;result:{state:'configured'|'repair_required'}};

  "settings.value":{params:{fieldId:string;selectors:string[]};result:import('./settings.js').SettingChange};
  "settings.read":{params:{offset?:number;section:import('./settings.js').SettingsSection};result:import('./settings.js').SettingsPage};
  "settings.review":{params:{windowId:string;generation:number;changes:import('./settings.js').SettingChange[]};result:import('./settings.js').SettingsReview};
  "settings.cancel":{params:import('./settings.js').SettingsBinding;result:{cancelled:boolean}};
  "artifacts.list":{params:{cursor?:string};result:{items:import('./artifacts.js').ArtifactProjection[];nextCursor:string|null}};
  "browser.control":{params:{workId:string;command:import('./browser-human.js').HumanBrowserCommand};result:import('./browser-human.js').HumanBrowserResult};
  "browser.snapshot":{params:{workId:string;reference:import('./browser.js').BrowserViewReference};result:import('./browser.js').BrowserViewSnapshot};
  "browser.list":{params:{workId:string};result:{items:import('./browser.js').BrowserViewState[];truncated:boolean}};
  "artifacts.get":{params:{reference:import('./artifacts.js').ArtifactReference};result:import('./artifacts.js').ArtifactPreview};
  "artifacts.open":{params:{reference:import('./artifacts.js').ArtifactReference};result:import('./artifacts.js').ArtifactPreview};
  "evidence.get":{params:{workId:string};result:import('./evidence.js').EvidenceReport};
  "terminal.acquire":{params:{target:TargetReference};result:{capabilityId:string;target:TargetReference;workingRoot:string;backend:'host'|'docker';expiresAt:number;container:{id:string;user:string;endpoint:string}|null}};
  "terminal.verify":{params:{capabilityId:string};result:{expiresAt:number}};
  "terminal.release":{params:{capabilityId:string;settled:true};result:{released:boolean}};
  "diff.list":{params:{target:TargetReference};result:{items:{path:string;previousPath:string|null;stage:'staged'|'unstaged'|'untracked';status:'added'|'modified'|'deleted'|'renamed'|'copied'|'type_changed'|'conflicted';binary:boolean|null;previewable:boolean}[];truncated:boolean}};
  "diff.patch":{params:{target:TargetReference;path:string;stage:'staged'|'unstaged'|'untracked'};result:{path:string;stage:'staged'|'unstaged'|'untracked';binary:boolean;text:string|null;truncated:boolean}};
  "files.list":{params:{target:TargetReference;path:string;cursor?:string};result:{nextCursor?:string;items:{path:string;name:string;kind:'file'|'directory'|'symlink'|'special'}[];truncated:boolean}};
  "files.preview":{params:{target:TargetReference;path:string};result:{path:string;size:number;binary:boolean;text:string|null;truncated:boolean}};
  "targets.inspectOperation":{params:{operationId:string};result:TargetOperation};
  "targets.execute":{params:{operationId:string;action:'archive'|'cleanup';target:TargetReference;confirmed:true};result:TargetOperation};
  "targets.cancelReview":{params:{reviewId:string};result:{cancelled:boolean}};
  "targets.create":{params:{reviewId:string;source:TargetReference;trustNewPath:true};result:TargetOperation};
  "targets.reviewCreate":{params:{source:TargetReference};result:TargetCreationReview};
  "targets.inspect":{params:{target:TargetReference};result:TargetInspection};
  "targets.list":{params:{cursor?:string};result:{items:TargetDetails[];truncated:boolean;nextCursor?:string}};
  "telegram.handoff":{params:{operationId:string;sessionId:string;action:'create'|'revoke'|'detach';attachmentId?:string;confirmed:true};result:ConnectionOperation};
  "telegram.sessionDetails":{params:{sessionId:string};result:TelegramSessionDetails};
  "telegram.sessions":{params:Record<string,never>;result:{items:TelegramSession[];truncated:boolean}};
  "telegram.pairing":{params:Record<string,never>;result:TelegramPairing};
  "telegram.execute":{params:{operationId:string;action:TelegramOperationAction;destination?:string;confirmed:true};result:ConnectionOperation};
  "gateway.diagnostics":{params:Record<string,never>;result:GatewayDiagnostics};
  "gateway.execute":{params:{operationId:string;action:GatewayAction;acknowledgeSharedWork:true};result:ConnectionOperation};
  "connections.inspectOperation":{params:{operationId:string};result:ConnectionOperation};
  "telegram.verify":{params:TelegramVerify;result:TelegramVerification};
  "telegram.settings":{params:Record<string,never>;result:TelegramSettings};
  "telegram.review":{params:TelegramReview;result:TelegramDraft};
  "telegram.apply":{params:ModelDraftBinding;result:ModelApplyReceipt};
  "telegram.cancel":{params:ModelDraftBinding;result:{cancelled:boolean}};
  "telegram.inspectApply":{params:{operationId?:string};result:ModelApplyReceipt};
  "work.usage":{params:{workId:string};result:WorkUsageProjection};
  "work.counts":{params:Record<string,never>;result:RuntimeCounts};
  "tasks.create":{params:SessionControl&{taskId:string;objective:string;limits:{maxProviderCalls:number;maxTotalTokens:number;maxWallClockMs:number};selection:{providerId:string;modelId:string}|null};result:OperationReceipt};
  "work.live": {params:{workId:string};result:{active:boolean;turnId:string|null;text:string;truncated:boolean}};
  "work.targets": {params:{cursor?:string;target?:TargetReference};result:{items:TargetProjection[];truncated:boolean;nextCursor?:string}};
  "models.verifyDraft": {params:ModelDraftBinding&{spendApproved:true;allowPrivateEndpoint:boolean};result:CandidateVerification};
  "models.importOptions": {params:{sourceProfileId:string};result:{items:{id:string;providerId:string;modelId:string;endpoint:string;available:boolean;requiresSignIn:boolean}[]}};
  "models.reviewImport": {params:{sourceProfileId:string;routeId:string;providerId:string;modelId:string;endpoint:string;confirmed:true;windowId:string;generation:number};result:ModelRouteDraft};
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
  "models.reviewProvider": {params: Omit<VerifyCandidateParams,'spendApproved'>;result:ModelRouteDraft};
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
  "inbox.get":{params:{itemId:string};result:InboxProjection};
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
  "sessions.send": { params: SessionControl & { text: string; mediaIds?:string[]; securityMode?: 'strict'|'adaptive'|'open'; interrupt?:boolean; }; result: OperationReceipt };
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
