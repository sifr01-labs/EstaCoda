import {useCallback,useEffect,useRef,useState} from 'react';
import type {ConnectionOperation,SettingsDependenciesPage} from '@estacoda/control-protocol';
import type {DesktopSettingsApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {Button,Icon} from './primitives.js';

type Spec=SettingsDependenciesPage['items'][number];
const names:Record<string,string>={'faster-whisper':'Faster Whisper','edge-tts':'Edge speech',ddgs:'DDGS'};
const unresolved=(receipt:ConnectionOperation|null)=>receipt?.state==='uncertain'||receipt?.state==='unknown';
const belongs=(receipt:ConnectionOperation|null,id:string)=>(receipt?.action==='dependency.install:'+id||receipt?.action.startsWith('dependency.install:'+id+':'));

/** Reads automatically; only an explicit reviewed click may start a registered download. */
export function useCapabilityDependencies(api:DesktopSettingsApi,enabled:boolean,scope:'voice'|'search'|'execution'='voice'){
 const [items,setItems]=useState<Spec[]>([]),[checking,setChecking]=useState(enabled),[failed,setFailed]=useState(false);
 const [receipt,setReceipt]=useState<ConnectionOperation|null>(null),[lost,setLost]=useState(false),[installing,setInstalling]=useState<string>();
 const [selected,setSelected]=useState<string>();
 const epoch=useRef(0),lock=useRef(false),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),restore=useRef<HTMLElement|null>(null);
 const read=useCallback(async(generation:number)=>{
  // Read software after the receipt so a just-completed install gets a fresh check.
  const operation=await api.inspectDependency();
  const page=await api.dependencies();
  if(epoch.current!==generation)return;
  setItems(page.items.filter(i=>scope==='execution'?i.id==='docker-execution':scope==='search'?i.id==='ddgs':['faster-whisper','edge-tts'].includes(i.id)));setReceipt(operation);setLost(false);setFailed(false);
  return {page,operation};
 },[api,scope]);
 const refresh=useCallback(async()=>{
  if(lock.current)return;lock.current=true;const generation=epoch.current;setChecking(true);
  try{await read(generation);}catch{if(epoch.current===generation)setFailed(true);}
  finally{if(epoch.current===generation){lock.current=false;setChecking(false);}}
 },[read]);
 useEffect(()=>{
  const generation=++epoch.current;lock.current=false;if(enabled)setItems([]);setReceipt(null);setLost(false);setFailed(false);setSelected(undefined);setInstalling(undefined);
  if(enabled)void refresh();else setChecking(false);
  return()=>{if(epoch.current===generation)epoch.current++;clearTimeout(timer.current);};
 },[enabled,refresh]);
 const pending=lost||unresolved(receipt);
 // Bounded read-only reconciliation. A lost response must never replay an installation.
 useEffect(()=>{
  if(!enabled||!pending)return;let cancelled=false,checks=0;
  const poll=async()=>{if(cancelled)return;await refresh();if(!cancelled&&++checks<30)timer.current=setTimeout(poll,2000);};
  timer.current=setTimeout(poll,2000);return()=>{cancelled=true;clearTimeout(timer.current);};
 },[enabled,pending,refresh]);
 const install=async()=>{
  if(lock.current||pending||!selected||!items.some(i=>i.id===selected))return;
  const id=selected,generation=epoch.current;lock.current=true;setInstalling(id);setFailed(false);
  try{
   // Reconcile again immediately before a write; another window may have installed it.
   const current=await read(generation);if(!current||epoch.current!==generation||unresolved(current.operation))return;
   if(current.page.items.find(i=>i.id===id)?.state!=='install_required')return;
   const operation=await api.install(id,[],true);
   if(epoch.current!==generation)return;setReceipt(operation);
   await read(generation);
  }catch{if(epoch.current===generation){setLost(true);setFailed(true);}}
  finally{if(epoch.current===generation){lock.current=false;setInstalling(undefined);}}
 };
 const open=(id:string)=>{restore.current=document.activeElement as HTMLElement;setSelected(id);};
 const close=()=>{setSelected(undefined);requestAnimationFrame(()=>restore.current?.isConnected&&restore.current.focus());};
 return {items,checking,failed,receipt,pending,installing,selected,refresh,install,open,close};
}
export type VoiceDependencies=ReturnType<typeof useCapabilityDependencies>;
export function VoiceInstallStatus({state,id}:{state:VoiceDependencies;id:string}){
 const {t}=useI18n(),spec=state.items.find(i=>i.id===id),pending=belongs(state.receipt,id)&&state.pending||state.installing===id;
 const label=pending?'Confirming installation…':state.checking&&!spec?'Checking installation…':state.failed||!spec?"Couldn’t check installation":spec.state==='installed'?'Installed':'Setup required';
 return <span className={label==='Installed'?'ec-media-good':''}><Icon name={label==='Installed'?'circle-check':pending||state.checking?'loader-circle':label==='Setup required'?'circle-dashed':'circle-alert'}/>{t(label)}</span>;
}
export function VoiceInstallAction({state,id,disabled}:{state:VoiceDependencies;id:string;disabled:boolean}){
 const {t}=useI18n(),spec=state.items.find(i=>i.id===id);
 if(state.checking&&!spec)return null;
 if(state.pending||state.installing)return <Button className="ec-ghost" disabled={disabled||state.checking||!!state.installing} onClick={()=>void state.refresh()}>{t('Check status')}</Button>;
 if(state.failed||!spec)return <Button className="ec-ghost" disabled={disabled||state.checking} onClick={()=>void state.refresh()}>{t('Check again')}</Button>;
 if(spec.state==='installed')return null;
 return <Button className="ec-primary" disabled={disabled||state.checking} onClick={()=>state.open(id)}>{t('Install…')}</Button>;
}
export function VoiceInstallReview({state}:{state:VoiceDependencies}){
 const {t,language}=useI18n(),heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{heading.current?.focus();},[state.selected]);
 const spec=state.items.find(i=>i.id===state.selected);if(!state.selected||!spec)return null;
 const installed=spec.state==='installed',pending=state.pending||!!state.installing,failed=belongs(state.receipt,spec.id)&&state.receipt?.state==='failed';
 return <section className="ec-voice-install" aria-label={t(spec.id==='ddgs'?'Search setup':'Voice setup')}>
  <div className="ec-voice-install-heading"><Icon name={installed?'circle-check':'arrow-down'}/><h3 ref={heading} tabIndex={-1}>{t(installed?'{engine} is installed':'Set up {engine}',{engine:names[spec.id]!})}</h3></div>
  <p>{t(spec.id==='ddgs'?'Download search software. Your search settings stay in their separate review.':'Download the software this engine needs. Your model and voice settings stay in their separate review.')}</p>
  <div className="ec-voice-install-facts"><span>{t('Estimated disk space')}</span><bdi>{spec.estimatedMb===null?t('Size varies'):new Intl.NumberFormat(language).format(spec.estimatedMb)+' MB'}</bdi></div>
  <details><summary>{t('Included software')}</summary><ul>{spec.packages.map(p=><li key={p}><bdi>{p}</bdi></li>)}</ul></details>
  {spec.id==='faster-whisper'&&<p className="ec-footnote">{t('Transcription model files are separate. Installing this software does not confirm they are downloaded.')}</p>}
  {pending&&<p role="status">{t('Installation may still be running. Checking its status will not start another download.')}</p>}
  {failed&&<p role="alert">{t('Installation did not complete. Review the software and try again.')}</p>}
  {state.failed&&<p role="alert">{t('Could not confirm installation. Check status before trying again.')}</p>}
  <div className="ec-model-footeractions"><Button onClick={state.close}>{t(installed?'Done':pending?'Close':'Cancel')}</Button>{!installed&&(pending?<Button disabled={state.checking||!!state.installing} onClick={()=>void state.refresh()}>{t('Check status')}</Button>:<Button className="ec-primary" disabled={state.checking||state.failed} onClick={()=>void state.install()}>{t('Download and install')}</Button>)}</div>
 </section>;
}
