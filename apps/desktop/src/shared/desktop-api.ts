import type {MethodContracts} from '@estacoda/control-protocol';
import type {AppearancePreferences} from './appearance.js';
import type { ActivityProjection, Page, WorkProjection, InboxProjection } from '@estacoda/control-protocol';
export type DesktopSnapshot = { status: 'connecting' | 'ready' | 'disconnected' | 'incompatible' | 'unavailable';
  profile: {id:string;label:string;configuration:'unconfigured'|'ready'|'repair_required'};
  runtime: 'stopped'|'starting'|'ready'|'disconnected'|'incompatible'|'unavailable';
  work:Page<WorkProjection>;inbox:Page<InboxProjection> };
export type ProfileChoice = {id:string;label:string};
export type DesktopModelsApi={
 models(cursor?:string):Promise<MethodContracts['models.list']['result']>;
 providers(cursor?:string):Promise<MethodContracts['providers.list']['result']>;
 refreshCatalog():Promise<{refreshed:boolean}>;
};
export type DesktopApi = {
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
