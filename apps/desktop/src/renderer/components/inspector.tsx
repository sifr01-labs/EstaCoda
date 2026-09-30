import {RuntimeDetails} from './runtime-details.js';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {useEffect,useRef,useState} from 'react';
import {ConnectorPanel} from './connector-panel.js';
import type {Draft} from '../app.js';
import type {DesktopModelsApi} from '../../shared/desktop-api.js';
import type {TargetProjection} from '@estacoda/control-protocol';
import type{DesktopWorkApi}from'../../shared/desktop-api.js';
import{WorkUsage}from'./work-usage.js';
import type{ActivityProjection,WorkProjection}from'@estacoda/control-protocol';
import type{FixturePhase}from'../adapter.js';import{Button,Icon}from'./primitives.js';
export function Inspector({work,fixture,phase,plan,api,models,draft,runtimeApi,close,overviewRequest=0}:{close?:()=>void;overviewRequest?:number;runtimeApi?:DesktopApi;models?:DesktopModelsApi;draft?:Draft;api?:DesktopWorkApi;plan?:Extract<ActivityProjection,{kind:'plan'}>;work?:WorkProjection;fixture:boolean;phase?:FixturePhase}){
 const {t,status,language}=useI18n();
 const [tab,setTab]=useState<'overview'|'plan'|'activity'>('overview');
 const [copied,setCopied]=useState(false),[copyError,setCopyError]=useState(false);
 const panel=useRef<HTMLElement>(null);
 const [width,setWidth]=useState(()=>{try{return Math.max(320,Math.min(440,Number(localStorage.getItem('estacoda.details-width'))||340));}catch{return 340;}});
 useEffect(()=>{setTab('overview');document.getElementById('ec-details-tab-overview')?.focus();},[overviewRequest,work?.id]);
 useEffect(()=>{const scroll=panel.current?.querySelector('.ec-details-scroll');if(scroll)scroll.scrollTop=0;},[tab]);
 useEffect(()=>{const body=panel.current?.parentElement;if(!body)return;body.style.setProperty('--ec-details-width',width+'px');try{localStorage.setItem('estacoda.details-width',String(width));}catch{}return()=>{body.style.removeProperty('--ec-details-width');};},[width]);
 useEffect(()=>{if(!copied&&!copyError)return;const timer=setTimeout(()=>{setCopied(false);setCopyError(false);},1800);return()=>clearTimeout(timer);},[copied,copyError]);
 const copyId=async()=>{try{if(runtimeApi?.clipboard)await runtimeApi.clipboard.writeText(work!.canonicalId);else await navigator.clipboard.writeText(work!.canonicalId);setCopied(true);}catch{setCopyError(true);}};
 const resize=(event:import('react').PointerEvent<HTMLDivElement>)=>{event.preventDefault();const el=event.currentTarget,start=event.clientX;el.setPointerCapture(event.pointerId);const move=(e:PointerEvent)=>setWidth(Math.max(320,Math.min(440,width+(e.clientX-start)*(language==='ar'?1:-1))));const end=()=>{el.removeEventListener('pointermove',move);el.removeEventListener('lostpointercapture',end);};el.addEventListener('pointermove',move);el.addEventListener('lostpointercapture',end);};
 const [execution,setExecution]=useState<{target?:TargetProjection;model:string}|null>(null);
 useEffect(()=>{
  if(fixture||!api||!models)return;let cancelled=false;
  const refresh=async()=>{
   try{
    const [targets,catalog,override]=await Promise.all([api.targets(),models.models(),work?.modelBinding&&['session','task'].includes(work.kind)?models.workOverride(work.id):Promise.resolve(null)]);
    const binding=work?.target??draft?.target;
    const target=targets.items.find(target=>target.targetId===binding?.targetId&&target.targetGeneration===binding.targetGeneration);
    const selected=work?override?.selection:draft?.modelSelection;
    const primary=catalog.items.find(row=>row.role==='primary');
    if(!cancelled)setExecution({target,model:work?.executionModel?work.executionModel.modelId:work&&!work.modelBinding?t("Unavailable"):selected?catalog.items.find(row=>row.providerId===selected.providerId&&row.id===selected.modelId)?.label??selected.modelId:primary?primary.label:t("Unavailable")});
   }catch{if(!cancelled)setExecution(null);}
  };
  setExecution(null);void refresh();const timer=setInterval(()=>void refresh(),3000);
  return()=>{cancelled=true;clearInterval(timer);};
 },[api,models,fixture,work?.id,work?.profileId,work?.executionModel?.modelId,work?.target?.targetId,work?.target?.targetGeneration,draft?.target?.targetId,draft?.target?.targetGeneration,draft?.modelSelection?.providerId,draft?.modelSelection?.modelId]);

 const final=work?.id!=='retry'||phase==='done';
 const steps=fixture&&work?[t('Inspect the current behavior'),work.id==='retry'?t('Implement bounded retries'):t('Review the available evidence'),work.id==='retry'?t('Verify with focused tests'):t('Summarize findings and limits')].map((title,index)=>({id:String(index),title,status:index===2&&!final?'pending':'completed'})):plan?.steps??[];
 const completed=steps.filter(step=>step.status==='completed').length;
 const running=fixture?phase==='running':work?.status==='running';
 const tabs=['overview','plan','activity'] as const;
 const labels={overview:t('Overview'),plan:t('Plan'),activity:t('Activity')};
 const target=work?.target??draft?.target;
 return <aside ref={panel} id="ec-details" className="ec-inspector ec-details" aria-label={t(work?'Work details':'Draft details')} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close?.();}}}>
  <div className="ec-details-resize" role="separator" aria-label={t('Details width')} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={440} aria-valuenow={width} tabIndex={0} onPointerDown={resize} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();setWidth(value=>event.key==='Home'?320:event.key==='End'?440:Math.max(320,Math.min(440,value+(event.key==='ArrowLeft'?16:-16)*(language==='ar'?-1:1))));}}}/>
  <header className="ec-details-header"><h2>{t('Details')}</h2>{close&&<Button className="ec-ghost ec-iconbutton" icon="x" aria-label={t('Close details')} onClick={close}/>}</header>
  <div className="ec-details-tabs" role="tablist" aria-label={t('Details sections')}>{tabs.map((value,index)=><button key={value} type="button" role="tab" id={'ec-details-tab-'+value} aria-controls={'ec-details-'+value} aria-selected={tab===value} tabIndex={tab===value?0:-1} onClick={()=>setTab(value)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?2:(index+((event.key==='ArrowRight')===(language!=='ar')?1:2))%3;setTab(tabs[next]!);document.getElementById('ec-details-tab-'+tabs[next])?.focus();}}}>{labels[value]}{value==='plan'&&steps.length>0&&<span>{completed}/{steps.length}</span>}</button>)}</div>
  <div className="ec-details-scroll">
   <section id="ec-details-overview" role="tabpanel" aria-labelledby="ec-details-tab-overview" tabIndex={0} hidden={tab!=='overview'}>
    <section className="ec-inspectsection"><div className="ec-inspecttitle">{t(work?work.kind==='session'?'Conversation':'Work':'New chat')}</div><dl>
     {work?<div className="ec-kv"><dt>{t('Status')}</dt><dd>{status(work.status)}</dd></div>:<p className="ec-footnote">{t('Nothing is running.')}</p>}
     <div className="ec-kv"><dt>{t('Workspace')}</dt><dd><bdi>{work?.target?.label??draft?.targetLabel??(target?t('Selected workspace'):t('No workspace attached'))}</bdi></dd></div>
     {fixture?<div className="ec-kv"><dt>{t('Environment')}</dt><dd>{t('Local host · not sandboxed')}</dd></div>:runtimeApi&&work&&<RuntimeDetails api={runtimeApi} profile={work?.profileId??''}/>}
     {!fixture&&execution?.target?.isolation&&<div className="ec-kv"><dt>{t('Isolation')}</dt><dd>{execution.target.isolation==='host'?t('Not sandboxed'):execution.target.isolation==='sandboxed'?t('Sandboxed target'):t('Isolation unavailable')}</dd></div>}
     <div className="ec-kv"><dt title={t('Model selection applies to the next message or attempt.')}>{t('Model')}</dt><dd><bdi>{fixture?'Kimi K3':execution?.model??t('Unavailable')}</bdi></dd></div>
     <div className="ec-kv"><dt>{t('Profile approval mode')}</dt><dd>{fixture?t('Strict'):execution?.target?.approvalMode?status(execution.target.approvalMode):t('Unavailable')}</dd></div>
     {work?.kind!=='task'&&draft?.kind!=='task'&&draft?.securityMode&&<div className="ec-kv"><dt>{t('Next message permissions')}</dt><dd>{status(draft.securityMode)}</dd></div>}
     {fixture&&work&&<div className="ec-kv"><dt>{t('Working branch')}</dt><dd><bdi>{work.id==='retry'?'ame/billing-retries':'main'}</bdi></dd></div>}
    </dl></section>
    {work&&(!fixture&&api?<WorkUsage key={work.profileId+work.id} api={api} work={work}/>:<section className="ec-inspectsection"><div className="ec-inspecttitle">{t('Usage')} <span>{t('Sample')}</span></div><dl><div className="ec-kv"><dt>{t('Reported tokens')}</dt><dd>8,420</dd></div><div className="ec-kv"><dt>{t('Cost estimate')}</dt><dd>{t('Unavailable')}</dd></div></dl></section>)}
    {!fixture&&work?.kind==='session'&&work.target&&runtimeApi?.connections&&<ConnectorPanel key={'connectors:'+work.profileId+work.id} api={runtimeApi.connections} workId={work.id} compact/>}
   </section>
   <section id="ec-details-plan" role="tabpanel" aria-labelledby="ec-details-tab-plan" tabIndex={0} hidden={tab!=='plan'}>
    {steps.length?<><div className="ec-plan-progress">{t('{completed} of {total} completed',{completed,total:steps.length})}<progress value={completed} max={steps.length}/></div>{steps.map(step=><details key={step.id} className={'ec-plan-step ec-plan-'+step.status} open={step.status==='running'?true:undefined}><summary><Icon name={step.status==='completed'?'circle-check':step.status==='running'&&running?'loader-circle':step.status==='failed'?'circle-alert':'circle-dashed'}/><span><span className="ec-plan-title" dir="auto">{step.title}</span><small>{step.status==='running'&&!running?t('Last recorded: in progress'):status(step.status)}</small></span><Icon name="chevron-down"/></summary></details>)}</>:<p className="ec-footnote">{t('No plan has been recorded for this chat.')}</p>}
   </section>
   <section id="ec-details-activity" role="tabpanel" aria-labelledby="ec-details-tab-activity" tabIndex={0} hidden={tab!=='activity'}>
    {!fixture&&<section id="ec-operation-details" className="ec-inspectsection"/>}
    <section className="ec-inspectsection"><details className="ec-technical-details"><summary>{t('Technical details')}</summary>{work&&<details><summary>{t('Work ID')}</summary><code className="ec-identity" dir="ltr">{work.canonicalId}</code><Button className="ec-ghost" icon="copy" onClick={()=>void copyId()}>{t('Copy ID')}</Button><span role="status">{copied?t('Copied'):copyError?t('Copy unavailable'):''}</span></details>}</details></section>
   </section>
  </div>
 </aside>;
}
