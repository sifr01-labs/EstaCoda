import {LiveProviderDialog} from './live-provider-dialog.js';
import {useI18n} from '../i18n.js';
import{useEffect,useRef,useState}from'react';
import type{ModelProjection,OperationReceipt,WorkProjection,ProviderProjection}from'@estacoda/control-protocol';
import type{DesktopModelsApi}from'../../shared/desktop-api.js';
import type{Draft}from'../app.js';
import{Button,Icon}from'./primitives.js';
export function WorkModelPicker({api,work,draft,change}:{api:DesktopModelsApi;work?:WorkProjection;draft:Draft;change:(draft:Draft)=>void}){
 const {t,owned}=useI18n();
 const[providers,setProviders]=useState<ProviderProjection[]>([]),[setup,setSetup]=useState(false),[query,setQuery]=useState(''),[revision,setRevision]=useState(0);
 const[open,setOpen]=useState(false),[rows,setRows]=useState<ModelProjection[]>([]),[cursor,setCursor]=useState<string|null>(null),[selection,setSelection]=useState<{providerId:string;modelId:string}|null>(draft.modelSelection??null),[receipt,setReceipt]=useState<OperationReceipt|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const supported=!work||!!work.modelBinding&&!!work.target&&['session','task'].includes(work.kind);
 useEffect(()=>{alive.current=true;let cancelled=false;void Promise.all([api.models(),work&&supported?api.workOverride(work.id):Promise.resolve(null),work&&supported?api.inspectOverride(work.id):Promise.resolve(null)]).then(([page,override,saved])=>{if(cancelled)return;setRows(page.items);setCursor(page.nextCursor);if(override)setSelection(override.selection);setReceipt(saved);},()=>{if(!cancelled)setError('Model information unavailable.');});return()=>{cancelled=true;alive.current=false;};},[api,work?.id,supported,revision]);
 const refresh=async()=>{if(!work)return;setBusy(true);try{const saved=await api.inspectOverride(work.id);const current=await api.workOverride(work.id);if(alive.current){setReceipt(saved);setSelection(current.selection);setError('');}}catch{if(alive.current)setError('Could not reconcile this change. Check again after reconnecting.');}finally{if(alive.current)setBusy(false);}};
 useEffect(()=>{if(!receipt||!['accepted','dispatched'].includes(receipt.state))return;const timer=setTimeout(()=>void refresh(),1500);return()=>clearTimeout(timer);},[receipt]);
 useEffect(()=>{if(open)panel.current?.querySelector<HTMLInputElement>('input')?.focus();},[open]);
 const close=()=>{setOpen(false);button.current?.focus();};
 useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!button.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
 const pick=async(value:string)=>{const row=rows.find(row=>row.providerId+'\n'+row.id===value);const next=row?{providerId:row.providerId,modelId:row.id}:null;if(!work){setSelection(next);change({...draft,modelSelection:next,model:row?.label??t("Profile default")});close();return;}setBusy(true);setError('');try{const result=await api.setOverride(work.id,next);if(alive.current){setReceipt(result);if(result.state==='completed')setSelection(next);}}catch{if(alive.current){setError('Model change not confirmed. Check its result before retrying.');setReceipt({state:'uncertain'} as OperationReceipt);}}finally{if(alive.current)setBusy(false);}};
 const pending=!!receipt&&receipt.state!=='completed';
 const primary=rows.find(row=>row.role==='primary');
 const selected=selection?rows.find(row=>row.id===selection.modelId&&row.providerId===selection.providerId):work?.kind==='task'?undefined:primary;
 const label=selected?.label??selection?.modelId??(work?.kind==='task'?t('Task default'):t('Model unavailable'));
 const running=work?.status==='running'&&work.executionModelActive===true?work.executionModel:undefined;
 const executionLabel=running?(rows.find(row=>row.id===running.modelId&&row.providerId===running.providerId)?.label??running.modelId):undefined;
 const displayedLabel=running?executionLabel+' · '+t(running.state==='failed'?'Model attempt failed':running.fallback?'Fallback':running.state==='attempting'?'Connecting':'Running'):label;
 const available=rows.filter(row=>row.runnable&&row.catalog?.configured!==false);
 const addProvider=async()=>{setBusy(true);setError('');try{const page=await api.providers();if(alive.current){setProviders(page.items);setOpen(false);setSetup(true);}}catch{if(alive.current)setError('Providers could not be loaded.');}finally{if(alive.current)setBusy(false);}};
 return <div className="ec-modelpicker"><button ref={button} className="ec-btn ec-ghost ec-modelcontrol" disabled={!supported} aria-label={t('Work model')} title={t(running?'Current execution model':'Model for the next message')} aria-expanded={open} onClick={()=>setOpen(value=>!value)}><bdi dir="ltr">{displayedLabel}</bdi><Icon name="chevron-down"/></button>{open&&<div ref={panel} className="ec-attachmenu ec-modelmenu" role="group" aria-label={t('Model for this Work')} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close();}else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const choices=[...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=choices.indexOf(document.activeElement as HTMLButtonElement);choices[(index+(event.key==='ArrowDown'?1:choices.length-1)+choices.length)%choices.length]?.focus();}}}>
 {running&&<p role="status">{t('Preferred model: {model}',{model:label})}</p>}
 <input type="search" aria-label={t('Find a model')} placeholder={t('Find a model')} value={query} onChange={event=>setQuery(event.target.value)}/>
 <div role="group" aria-label={t('Select Work model')}>
 <Button className="ec-modeloption" disabled={busy||pending} aria-pressed={!selection} onClick={()=>void pick('')}><span>{work?.kind==='task'?t('Use Task step defaults'):t('Use profile default')}<small><bdi>{work?.kind==='task'?'':primary?.label??t('Model unavailable')}</bdi></small></span>{!selection&&<Icon name="check"/>}</Button>
 {available.filter(row=>(row.label+' '+row.providerId+' '+row.id).toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(row=><Button className="ec-modeloption" key={row.providerId+'\n'+row.id} disabled={busy||pending} aria-pressed={selection?.modelId===row.id&&selection.providerId===row.providerId} onClick={()=>void pick(row.providerId+'\n'+row.id)}><span><bdi>{row.label}</bdi><small><bdi>{row.providerId}</bdi></small></span>{selection?.modelId===row.id&&selection.providerId===row.providerId&&<Icon name="check"/>}</Button>)}
 </div>
 <p>{work?(work.kind==='task'?t('Applies to future attempts. Active workers keep their current model.'):t('Applies at the next turn boundary. The active turn keeps its current model.')):t('Model for the next message')}</p>
 {receipt&&receipt.state!=='completed'&&<p role="status">{receipt.state==='accepted'||receipt.state==='dispatched'?t('Model change queued; waiting for the execution boundary.'):t('The result is uncertain. Reconcile before another change.')}</p>}{error&&<p role="alert">{owned(error)}</p>}
 {work&&pending&&<Button disabled={busy} onClick={()=>void refresh()}>{t('Check change result')}</Button>}
 {cursor&&<Button disabled={busy||rows.length>=2000} onClick={()=>{setBusy(true);void api.models(cursor).then(page=>{if(alive.current){setRows(old=>[...old,...page.items]);setCursor(page.nextCursor);}},()=>{if(alive.current)setError('More models unavailable.');}).finally(()=>{if(alive.current)setBusy(false);});}}>{t('Load more models')}</Button>}
 <Button className="ec-modeladd" icon="plus" disabled={busy||pending} onClick={()=>void addProvider()}>{t('Add a new provider…')}</Button><Button className="ec-ghost" onClick={close}>{t('Done')}</Button>
 </div>}{setup&&<LiveProviderDialog api={api} providers={providers} returnFocus={button.current} close={()=>{setSetup(false);setRevision(value=>value+1);}} saved={()=>setRevision(value=>value+1)}/>}</div>;
}
