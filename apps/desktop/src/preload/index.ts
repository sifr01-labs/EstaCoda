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
const invoke=async(method:string,payload:Record<string,unknown>={})=>{await ready;return ipcRenderer.invoke('desktop:'+method,{generation,payload});};
const api:DesktopApi={
  snapshot:async()=>{await ready;return snapshot;},
  onSnapshot:listener=>{listeners.add(listener);void ready.then(()=>{if(listeners.has(listener))listener(snapshot);});return()=>{listeners.delete(listener);};},
  activity:(workId,cursor)=>invoke('activity',{workId,...(cursor?{cursor}:{})}),
  profiles:()=>invoke('profiles'),switchProfile:id=>invoke('switchProfile',{id}),
  minimize:()=>invoke('minimize'),toggleMaximize:()=>invoke('toggleMaximize'),close:()=>invoke('close'),
};
contextBridge.exposeInMainWorld('desktop',Object.freeze(api));
