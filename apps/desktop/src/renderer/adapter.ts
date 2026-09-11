import type {DesktopApi,DesktopSnapshot} from '../shared/desktop-api.js';
import type {AppearanceStore} from '../shared/appearance.js';
export type FixturePhase='waiting'|'running'|'done'|'denied'|'stopping'|'stopped';
export type FixtureWork={id:string;title:string;prompt:string;summary:string;displayId:string};
export type FixtureArtifact={id:string;name:string;title:string;workId:string;kind:string;sections:{heading?:string;text:string}[]};
export type FixtureCapability={id:string;name:string;kind:string;status:'Available'|'Not configured';note:string};
export type FixtureControls={addedRoute:{provider:string;model:string}|null;addRoute:(provider:string,model:string)=>void;artifacts:FixtureArtifact[];capabilities:FixtureCapability[];work:Record<string,FixtureWork>;phase:FixturePhase;act:(action:'approve'|'deny'|'stop')=>void;subscribe:(listener:()=>void)=>()=>void};
export type DesktopAdapter={kind:'live'|'fixture';api:DesktopApi;appearance:AppearanceStore;fixture?:FixtureControls};
export const emptySnapshot:DesktopSnapshot={status:'connecting',profile:{id:'default',label:'default',configuration:'unconfigured'},runtime:'disconnected',work:{items:[],nextCursor:null},inbox:{items:[],nextCursor:null}};
