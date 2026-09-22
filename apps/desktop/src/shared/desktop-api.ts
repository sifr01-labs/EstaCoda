export type DesktopSettingsApi={
 workspaces():Promise<MethodContracts['settings.workspaces']['result']>;
 reviewAction(action:import('@estacoda/control-protocol').SettingsAction):Promise<MethodContracts['settings.reviewAction']['result']>;
 executeAction(reviewId:string,confirmed:true):Promise<MethodContracts['settings.executeAction']['result']>;
 cancelAction(reviewId:string):Promise<{cancelled:boolean}>;

 lifecycle?():Promise<MethodContracts['settings.lifecycle']['result']>;
 dependencies():Promise<MethodContracts['settings.dependencies']['result']>;
 install(capabilityId:string,groups:string[],downloadApproved:true):Promise<MethodContracts['settings.installDependency']['result']>;
 inspectDependency():Promise<MethodContracts['settings.inspectDependency']['result']|null>;
 value(fieldId:string,selectors:string[]):Promise<import('@estacoda/control-protocol').SettingChange>;
 read(section:import('@estacoda/control-protocol').SettingsSection,offset?:number):Promise<import('@estacoda/control-protocol').SettingsPage>;
 begin():Promise<{setupId:string}>;
 stage(setupId:string,fieldId:string,selectors:string[]):Promise<{staged:boolean}>;
 review(setupId:string,changes:import('@estacoda/control-protocol').SettingChange[]):Promise<import('@estacoda/control-protocol').SettingsReview>;
 apply(setupId:string):Promise<MethodContracts['settings.apply']['result']>;
 cancel(setupId:string):Promise<{cancelled:boolean}>;
 inspect():Promise<MethodContracts['settings.inspect']['result']>;
 verify():Promise<MethodContracts['settings.verify']['result']>;
};
import type {MethodContracts} from '@estacoda/control-protocol';
import type {AppearancePreferences} from './appearance.js';
import type { ActivityProjection, Page, WorkProjection, InboxProjection } from '@estacoda/control-protocol';
export type DesktopSnapshot = {databaseIssue?: 'upgrade_required' | 'newer_schema';counts?:import('@estacoda/control-protocol').RuntimeCounts|null; status: 'connecting' | 'ready' | 'disconnected' | 'incompatible' | 'unavailable';
  profile: {id:string;label:string;configuration:'unconfigured'|'ready'|'repair_required'};
  runtime: 'stopped'|'starting'|'ready'|'disconnected'|'incompatible'|'unavailable';
  work:Page<WorkProjection>;inbox:Page<InboxProjection> };
export type ProfileChoice = {id:string;label:string};
export type DesktopModelsApi={
 workOverride(workId:string):Promise<MethodContracts['models.workOverride']['result']>;
 setOverride(workId:string,selection:{providerId:string;modelId:string}|null):Promise<MethodContracts['sessions.setModel']['result']>;
 inspectOverride(workId:string):Promise<MethodContracts['operations.inspect']['result']|null>;

 verifyReviewed(setupId:string,allowPrivateEndpoint:boolean):Promise<MethodContracts['models.verifyDraft']['result']>;
 routes():Promise<{fallbacks:MethodContracts['models.fallbacks']['result'];auxiliary:MethodContracts['models.auxiliary']['result']}>;
 reviewConfigured(selection:Omit<MethodContracts['models.reviewConfigured']['params'],'windowId'|'generation'>):Promise<{setupId:string;draft:MethodContracts['models.reviewPrimary']['result']}>;
 reviewOrder(order:Omit<MethodContracts['models.reviewFallbackOrder']['params'],'windowId'|'generation'>):Promise<{setupId:string;draft:MethodContracts['models.reviewPrimary']['result']}>;
 reviewMode(mode:Omit<MethodContracts['models.reviewAuxiliaryMode']['params'],'windowId'|'generation'>):Promise<{setupId:string;draft:MethodContracts['models.reviewPrimary']['result']}>;

 oauthStart(setupId:string):Promise<MethodContracts['models.oauthStart']['result']>;
 oauthStatus(setupId:string):Promise<MethodContracts['models.oauthStatus']['result']>;
 oauthOpen(setupId:string):Promise<void>;

 begin(route:MethodContracts['models.validateRoute']['params']['route']):Promise<{setupId:string}>;
 stage(setupId:string):Promise<{staged:boolean}>;
 verify(setupId:string):Promise<MethodContracts['models.verifyCandidate']['result']>;
 review(setupId:string,role?:import('@estacoda/control-protocol').RouteRole):Promise<MethodContracts['models.reviewPrimary']['result']>;
 apply(setupId:string):Promise<MethodContracts['models.applyDraft']['result']>;
 cancel(setupId:string):Promise<{cancelled:boolean}>;
 inspect():Promise<MethodContracts['models.inspectApply']['result']|null>;

 models(cursor?:string):Promise<MethodContracts['models.list']['result']>;
 providers(cursor?:string):Promise<MethodContracts['providers.list']['result']>;
 refreshCatalog():Promise<{refreshed:boolean}>;
};
export type WorkAction={workId:string;action:'sessions.resume'|'sessions.cancelTurn'|'tasks.pause'|'tasks.resume'|'tasks.cancel'|'tasks.retry'|'tasks.guide';stepId?:string;guidance?:string};
export type WorkSubmission={inspectOnly?:boolean;securityMode?: 'strict'|'adaptive'|'open'; interrupt?:boolean;kind?:'session'|'task';limits?:{maxProviderCalls:number;maxTotalTokens:number;maxWallClockMs:number};draftId:string;workId?:string;target:import('@estacoda/control-protocol').TargetReference;text:string;attachmentIds:string[];selection?:{providerId:string;modelId:string}|null};
export type ComposerAttachment={id:string;name:string;size:number;type:string;thumbnail?:string};
export type DesktopWorkApi = {
 usage(workId:string):Promise<import('@estacoda/control-protocol').WorkUsageProjection>;
 decide(itemId:string,decision:'approved'|'denied'):Promise<import('@estacoda/control-protocol').OperationReceipt>;
 inspectDecision(itemId:string):Promise<import('@estacoda/control-protocol').OperationReceipt|null>;
 act(input:WorkAction):Promise<import('@estacoda/control-protocol').OperationReceipt>;
 children(workId:string,cursor?:string):Promise<Page<WorkProjection>>;
 live(workId:string):Promise<MethodContracts['work.live']['result']>;
 targets(options?:MethodContracts['work.targets']['params']):Promise<MethodContracts['work.targets']['result']>;
 attach(input:Pick<WorkSubmission,'draftId'|'target'>&{workspace?:boolean}):Promise<ComposerAttachment[]>;
 attachFiles?(input:Pick<WorkSubmission,'draftId'|'target'>,files:File[]):Promise<ComposerAttachment[]>;
 submit(input:WorkSubmission):Promise<{workId:string;receipt:import('@estacoda/control-protocol').OperationReceipt}>;
 inspect(workId:string):Promise<import('@estacoda/control-protocol').OperationReceipt|null>;
 search(query:string,cursor?:string):Promise<Page<WorkProjection>>;
 pins():Promise<WorkProjection[]>;
 pin(workId:string,pinned:boolean):Promise<WorkProjection[]>;
};
export type DesktopConnectionsApi={
 execute(action:import('@estacoda/control-protocol').TelegramOperationAction,confirmed:true,destination?:string):Promise<import('@estacoda/control-protocol').ConnectionOperation>;
 pairing():Promise<MethodContracts['telegram.pairing']['result']>;
 sessions():Promise<MethodContracts['telegram.sessions']['result']>;
 sessionDetails(workId:string):Promise<MethodContracts['telegram.sessionDetails']['result']>;
 handoff(workId:string,action:'create'|'revoke'|'detach',confirmed:true,attachmentId?:string):Promise<import('@estacoda/control-protocol').ConnectionOperation>;

 diagnostics():Promise<MethodContracts['gateway.diagnostics']['result']>;
 gateway(action:import('@estacoda/control-protocol').GatewayAction,acknowledgeSharedWork:true):Promise<import('@estacoda/control-protocol').ConnectionOperation>;
 inspectOperation():Promise<import('@estacoda/control-protocol').ConnectionOperation|null>;
 review(setupId:string,settings:import('@estacoda/control-protocol').TelegramSettings):Promise<MethodContracts['telegram.review']['result']>;
 apply(setupId:string):Promise<MethodContracts['telegram.apply']['result']>;
 inspectApply():Promise<MethodContracts['telegram.inspectApply']['result']>;
 begin():Promise<{setupId:string;settings:import('@estacoda/control-protocol').TelegramSettings}>;
 stage(setupId:string):Promise<{staged:boolean}>;
 verify(setupId:string):Promise<MethodContracts['telegram.verify']['result']>;
 cancel(setupId:string):Promise<{cancelled:boolean}>;
 connectors(input:MethodContracts['connections.connectors']['params']):Promise<MethodContracts['connections.connectors']['result']>;
 list():Promise<MethodContracts['connections.list']['result']>};
export type DesktopTargetsApi={
 list(cursor?:string):Promise<MethodContracts['targets.list']['result']>;
 inspect(target:import('@estacoda/control-protocol').TargetReference):Promise<MethodContracts['targets.inspect']['result']>;
 review(source:import('@estacoda/control-protocol').TargetReference):Promise<MethodContracts['targets.reviewCreate']['result']>;
 create(reviewId:string,trustNewPath:true):Promise<MethodContracts['targets.create']['result']>;
 cancel(reviewId:string):Promise<{cancelled:boolean}>;
 execute(action:'archive'|'cleanup',target:import('@estacoda/control-protocol').TargetReference,confirmed:true):Promise<MethodContracts['targets.execute']['result']>;
 operation():Promise<MethodContracts['targets.inspectOperation']['result']|null>;
};
export type DesktopFilesApi={
 list(input:MethodContracts['files.list']['params']):Promise<MethodContracts['files.list']['result']>;
 preview(input:MethodContracts['files.preview']['params']):Promise<MethodContracts['files.preview']['result']>;
};
export type DesktopDiffApi={
 list(input:MethodContracts['diff.list']['params']):Promise<MethodContracts['diff.list']['result']>;
 patch(input:MethodContracts['diff.patch']['params']):Promise<MethodContracts['diff.patch']['result']>;
};
export type DesktopTerminalApi={
 open(target:import('@estacoda/control-protocol').TargetReference):Promise<{id:string;backend:'host'|'docker'}>;
 read(id:string):Promise<{data:string;truncated:boolean;more:boolean;state:'running'|'stopping'|'closed'}>;
 write(id:string,data:string):Promise<void>;
 resize(id:string,cols:number,rows:number):Promise<void>;
 close(id:string):Promise<void>;
};
export type DesktopMicrophoneApi={begin(scope:{draftId:string;target:import('@estacoda/control-protocol').TargetReference}):Promise<{id:string;maxSeconds:number;sampleRate:number}>;append(id:string,data:string):Promise<{accepted:boolean}>;finish(id:string):Promise<{id:string;name:string;size:number;type:string}>;cancel(id:string):Promise<{cancelled:boolean}>};
export type DesktopLibraryApi={skills(offset?:number):Promise<MethodContracts['library.skills']['result']>;skill(id:string):Promise<MethodContracts['library.skill']['result']>;memory():Promise<MethodContracts['library.memory']['result']>;proposals(offset?:number):Promise<MethodContracts['library.proposals']['result']>;proposal(id:string):Promise<MethodContracts['library.proposal']['result']>};
export type DesktopEvolutionApi={review(input:MethodContracts['evolution.review']['params']):Promise<MethodContracts['evolution.review']['result']>;cancel(reviewId:string):Promise<{cancelled:boolean}>;execute(reviewId:string,confirmed:true):Promise<MethodContracts['evolution.execute']['result']>;inspect():Promise<MethodContracts['evolution.inspect']['result']|null>};
export type DesktopSchedulesApi={draft(id:string):Promise<MethodContracts['schedules.draft']['result']>;review(input:MethodContracts['schedules.review']['params']):Promise<MethodContracts['schedules.review']['result']>;cancel(reviewId:string):Promise<{cancelled:boolean}>;execute(reviewId:string,confirmed:true):Promise<MethodContracts['schedules.execute']['result']>;inspect():Promise<MethodContracts['schedules.inspect']['result']|null>;list(offset?:number):Promise<MethodContracts['schedules.list']['result']>;get(id:string):Promise<MethodContracts['schedules.get']['result']>;history(id:string,offset?:number):Promise<MethodContracts['schedules.history']['result']>};
export type DesktopApi = {
 updates?:Pick<import('./desktop-updates.js').DesktopUpdatesApi,'status'|'check'|'preferences'|'download'|'cancel'|'install'|'notes'|'diagnostics'>;installation?:{read():Promise<{acknowledged:boolean}>;acknowledge():Promise<void>;inspect():Promise<MethodContracts['setup.local']['result']>};schedules?:DesktopSchedulesApi;evolution?:DesktopEvolutionApi;library?:DesktopLibraryApi;onboarding?:{
 review(input:{modelSetupId:string;optionalSetupId?:string;preferences:import('@estacoda/control-protocol').SettingChange[];workspaceReviewId:string}):Promise<import('@estacoda/control-protocol').OnboardingReview>;
 apply(reviewId:string,confirmed:true):Promise<MethodContracts['setup.apply']['result']>;
 applyWorkspace(reviewId:string,confirmed:true):Promise<MethodContracts['setup.applyWorkspace']['result']>;
 inspect():Promise<MethodContracts['settings.inspect']['result']>;
 recover():Promise<MethodContracts['setup.recover']['result']>;
 verify(alias?:string):Promise<import('@estacoda/control-protocol').OnboardingVerification>;
 chooseWorkspace():Promise<{path:string;alias:string}|null>;
 reviewWorkspace(alias:string,trust:boolean):Promise<import('@estacoda/control-protocol').OnboardingWorkspaceReview>;
 cancelWorkspace(reviewId:string):Promise<{cancelled:boolean}>;
 detect():Promise<import("@estacoda/control-protocol").SetupDetection>;bootstrap():Promise<import("@estacoda/control-protocol").SetupDetection>};microphone?:DesktopMicrophoneApi;settings?:DesktopSettingsApi;
  readonly workInput?:{pending(workId:string):Promise<import('@estacoda/control-protocol').WorkInputRequest|null>;open(workId:string,requestId:string):Promise<void>};
  readonly browserControl?:{watch?(workId:string,browserId:string):Promise<import('@estacoda/control-protocol').HumanBrowserFrame>;signIn?(id:string,frameId:string,submitRef:string,kind:'password'|'one-time-code'):Promise<{submitted:boolean}>;inventory?(workId:string):Promise<import('@estacoda/control-protocol').BrowserWorkspaceState>;openWorkspace?(workId:string):Promise<{id:string}>;workspace?(id:string,operation:import('@estacoda/control-protocol').BrowserWorkspaceAction):Promise<import('@estacoda/control-protocol').BrowserWorkspaceState>;open(workId:string,reference:import('@estacoda/control-protocol').BrowserViewReference):Promise<{id:string}>;frame(id:string,input?:import('@estacoda/control-protocol').HumanBrowserInput):Promise<import('@estacoda/control-protocol').HumanBrowserFrame>;release(id:string):Promise<void>;abandon(id:string):Promise<void>};
  readonly browser?:{list(workId:string):Promise<MethodContracts['browser.list']['result']>;snapshot(workId:string,reference:import('@estacoda/control-protocol').BrowserViewReference):Promise<MethodContracts['browser.snapshot']['result']>};
  artifacts?:{media?(reference:import('@estacoda/control-protocol').ArtifactReference):Promise<{mimeType:string;data:string}>;save?(reference:import('@estacoda/control-protocol').ArtifactReference):Promise<{saved:boolean}>;list(cursor?:string):Promise<MethodContracts['artifacts.list']['result']>;get(reference:import('@estacoda/control-protocol').ArtifactReference):Promise<MethodContracts['artifacts.get']['result']>;open(reference:import('@estacoda/control-protocol').ArtifactReference):Promise<MethodContracts['artifacts.open']['result']>};
  evidence?:{get(workId:string):Promise<MethodContracts['evidence.get']['result']>};
  readonly terminal?:DesktopTerminalApi;
  readonly diff?:DesktopDiffApi;
  readonly files?:DesktopFilesApi;
  readonly targets?:DesktopTargetsApi;
  readonly connections?:DesktopConnectionsApi;
  readonly work?:DesktopWorkApi;
  readonly models?:DesktopModelsApi;
  readonly clipboard?:{writeText(text:string):Promise<void>};
  readonly chats?:{read(profile:string):Promise<import('./chat-presentation.js').ChatPresentation>;write(profile:string,value:import('./chat-presentation.js').ChatPresentation):Promise<void>;openFolder(workId:string):Promise<void>};
  readonly platform:string;
  appearance():Promise<AppearancePreferences>;
  setAppearance(value:AppearancePreferences):Promise<void>;
  reconnect():Promise<void>;
  moreWork():Promise<void>;
  moreInbox():Promise<void>;
  snapshot():Promise<DesktopSnapshot>;
  onSnapshot(listener:(snapshot:DesktopSnapshot)=>void):()=>void;
  getWork(workId:string):Promise<WorkProjection>;
  activity(workId:string,cursor?:string):Promise<Page<ActivityProjection>>;
  profiles():Promise<ProfileChoice[]>;
  switchProfile(id:string):Promise<void>;
  minimize():Promise<void>;
  toggleMaximize():Promise<void>;
  close():Promise<void>;
};
declare global { interface Window { desktop:DesktopApi } }
