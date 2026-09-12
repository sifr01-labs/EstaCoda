import type {MethodContracts} from '@estacoda/control-protocol';
import type {AppearancePreferences} from './appearance.js';
import type { ActivityProjection, Page, WorkProjection, InboxProjection } from '@estacoda/control-protocol';
export type DesktopSnapshot = { status: 'connecting' | 'ready' | 'disconnected' | 'incompatible' | 'unavailable';
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
export type DesktopWorkApi = {
 search(query:string,cursor?:string):Promise<Page<WorkProjection>>;
 pins():Promise<WorkProjection[]>;
 pin(workId:string,pinned:boolean):Promise<WorkProjection[]>;
};
export type DesktopApi = {
  readonly work?:DesktopWorkApi;
  readonly models?:DesktopModelsApi;
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
