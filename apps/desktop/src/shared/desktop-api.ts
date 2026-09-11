import type { ActivityProjection, Page, WorkProjection, InboxProjection } from '@estacoda/control-protocol';
export type DesktopSnapshot = { status: 'connecting' | 'ready' | 'disconnected' | 'incompatible' | 'unavailable';
  profile: {id:string;label:string;configuration:'unconfigured'|'ready'|'repair_required'};
  runtime: 'stopped'|'starting'|'ready'|'disconnected'|'incompatible'|'unavailable';
  work:Page<WorkProjection>;inbox:Page<InboxProjection> };
export type ProfileChoice = {id:string;label:string};
export type DesktopApi = {
  snapshot():Promise<DesktopSnapshot>;
  onSnapshot(listener:(snapshot:DesktopSnapshot)=>void):()=>void;
  activity(workId:string,cursor?:string):Promise<Page<ActivityProjection>>;
  profiles():Promise<ProfileChoice[]>;
  switchProfile(id:string):Promise<void>;
  minimize():Promise<void>;
  toggleMaximize():Promise<void>;
  close():Promise<void>;
};
declare global { interface Window { desktop:DesktopApi } }
