import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, DesktopSnapshot } from '../shared/desktop-api.js';
let generation=-1;
const listeners=new Set<(state:DesktopSnapshot)=>void>();
let snapshot:DesktopSnapshot;
ipcRenderer.on('desktop:state',(_event,binding:{generation:number;snapshot:DesktopSnapshot})=>{
  if(binding.generation<generation)return;generation=binding.generation;snapshot=binding.snapshot;
  for(const listener of listeners)listener(snapshot);
});
const ready=ipcRenderer.invoke('desktop:bind').then((binding:{generation:number;snapshot:DesktopSnapshot})=>{
  if(binding.generation>=generation){generation=binding.generation;snapshot=binding.snapshot;}
});
// Binding failures must surface as recovery state, not unhandled preload rejections.
void ready.catch(()=>{});
const invoke=async(method:string,payload:Record<string,unknown>={})=>{await ready;return ipcRenderer.invoke('desktop:'+method,{generation,payload});};
const api:DesktopApi={
  work:Object.freeze({children:(workId,cursor)=>invoke('workChildren',{workId,...(cursor?{cursor}:{})}),live:workId=>invoke('workLive',{workId}),targets:()=>invoke('workTargets'),attach:input=>invoke('workAttach',input),submit:input=>invoke('workSubmit',input),inspect:workId=>invoke('workInspect',{workId}),search:(query,cursor)=>invoke('workSearch',{query,...(cursor?{cursor}:{})}),pins:()=>invoke('workPins'),pin:(workId,pinned)=>invoke('workPin',{workId,pinned})}),
  models:Object.freeze({workOverride:workId=>invoke('workOverride',{workId}),setOverride:(workId,selection)=>invoke('setOverride',{workId,selection}),inspectOverride:workId=>invoke('inspectOverride',{workId}),verifyReviewed:(setupId,allowPrivateEndpoint)=>invoke('setupVerifyReviewed',{setupId,allowPrivateEndpoint}),routes:()=>invoke('modelRoutes'),reviewConfigured:selection=>invoke('setupConfigured',selection),reviewOrder:order=>invoke('setupOrder',order),reviewMode:mode=>invoke('setupMode',mode),oauthStart:setupId=>invoke('setupOAuthStart',{setupId}),oauthStatus:setupId=>invoke('setupOAuthStatus',{setupId}),oauthOpen:setupId=>invoke('setupOAuthOpen',{setupId}),begin:(route)=>invoke('setupBegin',{route}),stage:setupId=>invoke('setupStage',{setupId}),verify:setupId=>invoke('setupVerify',{setupId}),review:(setupId,role)=>invoke('setupReview',{setupId,...(role?{role}:{})}),apply:setupId=>invoke('setupApply',{setupId}),cancel:setupId=>invoke('setupCancel',{setupId}),inspect:()=>invoke('setupInspect'),models:(cursor?:string)=>invoke('modelPage',cursor?{cursor}:{}),providers:(cursor?:string)=>invoke('providerPage',cursor?{cursor}:{}),refreshCatalog:()=>invoke('refreshCatalog')}),
  platform:process.platform,
  reconnect:()=>invoke('reconnect'),moreWork:()=>invoke('moreWork'),moreInbox:()=>invoke('moreInbox'),
  appearance:()=>invoke('appearance'),setAppearance:value=>invoke('setAppearance',value),
  snapshot:async()=>{await ready;return snapshot;},
  onSnapshot:listener=>{listeners.add(listener);void ready.then(()=>{if(listeners.has(listener))listener(snapshot);},()=>{if(listeners.has(listener))listener({status:'unavailable',profile:{id:'default',label:'default',configuration:'unconfigured'},runtime:'unavailable',work:{items:[],nextCursor:null},inbox:{items:[],nextCursor:null}});});return()=>{listeners.delete(listener);};},
  getWork:workId=>invoke('getWork',{workId}),
  activity:(workId,cursor)=>invoke('activity',{workId,...(cursor?{cursor}:{})}),
  profiles:()=>invoke('profiles'),switchProfile:id=>invoke('switchProfile',{id}),
  minimize:()=>invoke('minimize'),toggleMaximize:()=>invoke('toggleMaximize'),close:()=>invoke('close'),
};
contextBridge.exposeInMainWorld('desktop',Object.freeze(api));
