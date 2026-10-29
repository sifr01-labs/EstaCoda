import {useEffect,useId,useRef,useState} from 'react';
import type {ArtifactReference} from '@estacoda/control-protocol';
import type {DesktopApi,DesktopSnapshot} from '../../shared/desktop-api.js';
import {imageKey,type ImageOutput,type imageRunState} from '../image-activity.js';
import {useI18n} from '../i18n.js';
import {Button,Icon} from './primitives.js';
import {fileSize} from './collection-ui.js';
import {useRetainedImage} from './use-retained-image.js';
import '../styles/image-canvas.css';

export type ImageEditAction=(reference:ArtifactReference,instruction:string)=>boolean;
type Generation=ReturnType<typeof imageRunState>;
type Props={images:ImageOutput[];reference?:ImageOutput;generation?:Generation;api:DesktopApi;profileId:string;workId:string;onEdit?:ImageEditAction;editDisabled?:boolean;onStop?:()=>Promise<void>;onRetry?:()=>boolean};

function ImageViewer({url,label,close}:{url:string;label:string;close:()=>void}){
 const {t}=useI18n(),dialog=useRef<HTMLDialogElement>(null),id=useId();
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null,node=dialog.current!;node.showModal();return()=>{node.close();previous?.focus();};},[]);
 return <dialog ref={dialog} className="ec-image-viewer" aria-labelledby={id} onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target===event.currentTarget)close();}}><header><h2 id={id} dir="auto">{label}</h2><Button className="ec-ghost" icon="x" onClick={close}>{t('Close')}</Button></header><img src={url} alt={label}/></dialog>;
}

/** A projection of retained evidence; provider text never creates controls or media URLs. */
export function ImageCanvas({images,reference,generation,api,profileId,workId,onEdit,editDisabled,onStop,onRetry}:Props){
 const {t,status}=useI18n(),region=useRef<HTMLElement>(null),scopeReady=useRef(false),scopeEpoch=useRef(0),id=useId();
 const [detailsOpen,setDetailsOpen]=useState(false),[visible,setVisible]=useState(false),[connected,setConnected]=useState(false),[scopeVersion,setScopeVersion]=useState(0),[checked,setChecked]=useState(false),[dimensions,setDimensions]=useState<{key:string;width:number;height:number}>(),[selectedKey,setSelectedKey]=useState(''),[compare,setCompare]=useState(false),[split,setSplit]=useState(50),[expanded,setExpanded]=useState(false),[retry,setRetry]=useState(0),[decodeFailure,setDecodeFailure]=useState(''),[instruction,setInstruction]=useState(''),[saving,setSaving]=useState(false),[stopping,setStopping]=useState(false),[notice,setNotice]=useState(''),[now,setNow]=useState(Date.now());
 const valid=(item:ImageOutput)=>item.profileId===profileId&&item.workId===workId;
 const outputs=images.filter(valid),source=reference&&valid(reference)?reference:undefined;
 const choices=[...(source?[source]:[]),...outputs.filter(item=>!source||imageKey(item)!==imageKey(source))];
 const latest=outputs.at(-1)??source,latestKey=latest?imageKey(latest):'';
 const selected=choices.find(item=>imageKey(item)===selectedKey)??latest;
 const key=selected?imageKey(selected):'';
 const running=generation?.state==='running';
 useEffect(()=>{setSelectedKey(latestKey);setCompare(false);},[latestKey]);
 useEffect(()=>{setExpanded(false);setCompare(false);setNotice('');setInstruction('');setDetailsOpen(false);},[key]);
 useEffect(()=>{
  let alive=true,observations=0;scopeEpoch.current++;scopeReady.current=false;setConnected(false);
  const apply=(snapshot:DesktopSnapshot)=>{const ready=snapshot.status==='ready'&&snapshot.profile.id===profileId;scopeReady.current=ready;setConnected(ready);setChecked(true);if(!ready){scopeEpoch.current++;setScopeVersion(value=>value+1);setExpanded(false);setCompare(false);setSaving(false);setStopping(false);setNotice('');}};
  const unsubscribe=api.onSnapshot(snapshot=>{observations++;if(alive)apply(snapshot);});
  const initial=observations;void api.snapshot().then(snapshot=>{if(alive&&observations===initial)apply(snapshot);}).catch(()=>{if(alive&&observations===initial){scopeReady.current=false;setConnected(false);}});
  return()=>{alive=false;scopeEpoch.current++;scopeReady.current=false;unsubscribe();};
 },[api,profileId,workId]);
 useEffect(()=>{
  const node=region.current;if(!node)return;
  if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'240px'});observer.observe(node);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{if(!running){setStopping(false);return;}setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[running,generation?.startedAt]);
 const image=useRetainedImage(api,selected,connected&&visible,retry,scopeVersion);
 const original=useRetainedImage(api,source,connected&&visible&&compare&&!!source&&key!==imageKey(source),retry,scopeVersion);
 const ready=connected&&image?.state==='ready'&&decodeFailure!==key+':'+retry;
 const unavailable=checked&&!connected||connected&&(image?.state==='unavailable'||decodeFailure===key+':'+retry);
 const canCompare=!!source&&!!selected&&imageKey(source)!==key;
 const canEdit=!!onEdit&&selected?.reference.source==='session'&&ready&&!running&&!editDisabled;
 const save=async()=>{if(!ready||!selected||saving||!api.artifacts?.save)return;const epoch=scopeEpoch.current;setSaving(true);setNotice('');try{const result=await api.artifacts.save(selected.reference);if(scopeReady.current&&epoch===scopeEpoch.current&&result.saved)setNotice('Image saved.');}catch{if(scopeReady.current&&epoch===scopeEpoch.current)setNotice('Image could not be saved.');}finally{if(scopeReady.current&&epoch===scopeEpoch.current)setSaving(false);}};
 const refine=(value:string)=>{if(!canEdit||!selected||!value.trim())return;if(onEdit!(selected.reference,value.trim())){setInstruction('');setNotice('');}};
 const stop=async()=>{if(!onStop||stopping||!connected)return;setStopping(true);try{await onStop();}catch{if(scopeReady.current){setStopping(false);setNotice('Stop request could not be confirmed. Use the chat Stop control.');}}};
 const label=selected?.label??t('Image');
 const failed=!outputs.length&&generation&&['failed','cancelled','interrupted'].includes(generation.state);
 const elapsed=generation?.startedAt?Math.max(0,Math.floor((now-generation.startedAt)/1000)):null;
 const generationLabel=generation?.editing?'Refining your image':'Creating your image';
 return <section ref={region} className="ec-image-canvas" aria-label={t('Image canvas')}>
  <div style={ready&&dimensions?.key===key?{aspectRatio:`${dimensions.width} / ${dimensions.height}`}:undefined} className={'ec-image-stage'+(ready?' ec-image-ready':'')+(running?' ec-image-generating':'')}>
   {ready&&<><button className="ec-image-open" type="button" aria-label={t('Expand image')} onClick={()=>setExpanded(true)} disabled={compare}><img src={image.url} alt={label} onLoad={event=>setDimensions({key,width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} onError={()=>setDecodeFailure(key+':'+retry)}/></button><Button className="ec-image-expand ec-ghost ec-iconbutton" icon="maximize" aria-label={t('Expand image')} onClick={()=>setExpanded(true)}/></>}
   {!ready&&<div className="ec-image-placeholder"><Icon name={unavailable||failed?'circle-alert':running?'sparkles':'image'}/><strong>{t(unavailable?'Image preview unavailable':failed?generation.state==='failed'?'Image could not be created':'Image creation stopped':running?generationLabel:!selected?generation?.active?'Waiting for image result':'Image result not recorded':'Loading your image')}</strong>{failed&&onRetry&&<Button disabled={editDisabled||!connected} onClick={()=>onRetry()}>{t('Retry image request')}</Button>}{unavailable&&<Button onClick={()=>setRetry(value=>value+1)}>{t('Retry preview')}</Button>}</div>}
   {running&&<div className={'ec-image-progress'+(!ready?' ec-image-progress-empty':'')} role="status"><Icon name="sparkles"/><span>{t(generationLabel)}</span>{elapsed!==null&&<small aria-hidden="true">{t('Elapsed: {seconds}s',{seconds:elapsed})}</small>}{onStop&&<Button className="ec-ghost" disabled={stopping||!connected} onClick={()=>void stop()} aria-label={t('Stop image generation')}>{t(stopping?'Stopping…':'Cancel')}</Button>}</div>}
   {ready&&compare&&canCompare&&<>{original?.state==='ready'?<div className="ec-image-comparison" aria-hidden="true"><img src={original.url} alt="" style={{clipPath:`inset(0 ${100-split}% 0 0)`}}/><div className="ec-image-split" style={{left:`${split}%`}}><span><Icon name="git-compare-arrows"/></span></div><span className="ec-image-before">{t('Reference image')}</span><span className="ec-image-after">{t('Result image')}</span></div>:<span className="ec-image-compare-loading" role="status">{t(original?.state==='unavailable'?'Image preview unavailable':'Loading your image')}</span>}<input type="range" min="0" max="100" value={split} onChange={event=>setSplit(Number(event.target.value))} className="ec-image-compare-range" aria-label={t('Compare reference and result')} disabled={original?.state!=='ready'}/></>}
  </div>
  {ready&&failed&&<div className="ec-image-notice" role="status"><span>{t(generation.state==='failed'?'Image could not be created':'Image creation stopped')}</span>{onRetry&&<Button disabled={editDisabled||!connected} onClick={()=>onRetry()}>{t('Retry image request')}</Button>}</div>}
  {selected&&<div className="ec-image-caption"><div><h3 dir="auto">{label}</h3><small><bdi>{selected.mimeType.slice(6).toUpperCase()}</bdi> · <bdi>{fileSize(selected.bytes)}</bdi></small></div><div className="ec-image-actions"><Button className="ec-ghost ec-iconbutton" icon="info" aria-label={t('Image details')} aria-controls={id} aria-expanded={detailsOpen} onClick={()=>setDetailsOpen(value=>!value)}/>{api.artifacts?.save&&<Button className="ec-image-save" icon="arrow-down" disabled={!ready||saving} onClick={()=>void save()}>{t(saving?'Saving…':'Save image')}</Button>}</div></div>}
  {selected&&<details id={id} className="ec-image-details" open={detailsOpen} onToggle={event=>setDetailsOpen(event.currentTarget.open)}><summary>{t('Image details')}</summary><dl><div><dt>{t('Integrity:')}</dt><dd>{ready?status('verified'):t('Image preview unavailable')}</dd></div>{image?.artifact&&<div><dt>{t('Saved output')}</dt><dd dir="auto">{image.artifact.displayName}</dd></div>}</dl></details>}
  {choices.length>1&&<div className="ec-image-versions" aria-label={t('Image versions')}>{choices.map((item,index)=><Button key={imageKey(item)} className="ec-ghost" icon="image" aria-pressed={imageKey(item)===key} onClick={()=>{setSelectedKey(imageKey(item));setCompare(false);}}>{source&&imageKey(item)===imageKey(source)?t('Reference image'):t('Image {number}',{number:index+(source?0:1)})}</Button>)}{canCompare&&<Button className="ec-ghost" icon="git-compare-arrows" disabled={!ready} aria-pressed={compare} onClick={()=>setCompare(value=>!value)}>{t('Compare images')}</Button>}</div>}
  {onEdit&&selected?.reference.source==='session'&&<div className="ec-image-refine"><form onSubmit={event=>{event.preventDefault();refine(instruction);}}><span className="ec-image-reference">{ready?<img src={image.url} alt={t('Reference image')}/>:<Icon name="image"/>}</span><input dir="auto" value={instruction} maxLength={4000} disabled={!canEdit} onChange={event=>setInstruction(event.target.value)} placeholder={t('Describe a change…')} title={editDisabled?t('Finish your current message before refining an image.'):undefined} aria-label={t('Refine image')}/><Button className="ec-image-send ec-iconbutton" type="submit" icon="arrow-up" aria-label={t('Refine image')} disabled={!canEdit||!instruction.trim()}/></form></div>}
  <div className="ec-image-notice" role="status">{notice&&t(notice as Parameters<typeof t>[0])}</div>
  {expanded&&ready&&<ImageViewer url={image.url} label={label} close={()=>setExpanded(false)}/>}
 </section>;
}
