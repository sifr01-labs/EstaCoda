import {useEffect,useState} from 'react';
import type {Draft} from '../app.js';
import type {DesktopModelsApi} from '../../shared/desktop-api.js';
import type {TargetProjection} from '@estacoda/control-protocol';
import type{DesktopWorkApi}from'../../shared/desktop-api.js';
import{WorkUsage}from'./work-usage.js';
import type{ActivityProjection,WorkProjection}from'@estacoda/control-protocol';
import type{FixturePhase}from'../adapter.js';import{Icon}from'./primitives.js';
export function Inspector({work,fixture,phase,plan,api,models,draft}:{models?:DesktopModelsApi;draft?:Draft;api?:DesktopWorkApi;plan?:Extract<ActivityProjection,{kind:'plan'}>;work?:WorkProjection;fixture:boolean;phase?:FixturePhase}){
 const [execution,setExecution]=useState<{target?:TargetProjection;model:string}|null>(null);
 useEffect(()=>{
  if(fixture||!api||!models)return;let cancelled=false;
  const refresh=async()=>{
   try{
    const [targets,catalog,override]=await Promise.all([api.targets(),models.models(),work?.modelBinding?models.workOverride(work.id):Promise.resolve(null)]);
    const binding=work?.target??draft?.target;
    const target=targets.items.find(target=>target.targetId===binding?.targetId&&target.targetGeneration===binding.targetGeneration);
    const selected=work?override?.selection:draft?.modelSelection;
    const primary=catalog.items.find(row=>row.role==='primary');
    if(!cancelled)setExecution({target,model:work&&!work.modelBinding?'Unavailable':selected?selected.providerId+' / '+selected.modelId:primary?primary.providerId+' / '+primary.id:'Unavailable'});
   }catch{if(!cancelled)setExecution(null);}
  };
  setExecution(null);void refresh();const timer=setInterval(()=>void refresh(),3000);
  return()=>{cancelled=true;clearInterval(timer);};
 },[api,models,fixture,work?.id,work?.profileId,draft?.target?.targetId,draft?.target?.targetGeneration,draft?.modelSelection?.providerId,draft?.modelSelection?.modelId]);
 if(!work)return <aside className="ec-inspector" aria-label="Draft details"><h3>New chat</h3><p className="ec-footnote">{fixture?<>Local host · not sandboxed<br/>Strict approval mode<br/>Nothing is running.</>:draft?.target?<><bdi>{execution?.target?.label??'Selected workspace'}</bdi><br/>{execution?.target?.isolation==='host'?'Local host · not sandboxed':'Isolation unavailable'}<br/>Profile approval mode: {execution?.target?.approvalMode??'Unavailable'}<br/>{draft.kind==='task'?'Next attempt model':'Next turn model'}: <bdi>{execution?.model??'Unavailable'}</bdi><br/>Nothing is running.</>:'No execution target is selected.'}</p></aside>;
 const final=work.id!=='retry'||phase==='done';
 return <aside className="ec-inspector" aria-label="Work details">{!fixture&&plan&&<section className="ec-inspectsection"><div className="ec-inspecttitle">Plan <span className="ec-subtle">{plan.steps.filter(step=>step.status==='completed').length} / {plan.steps.length}</span></div>{plan.steps.map(step=><div key={step.id} className={'ec-plan '+(step.status==='pending'?'ec-pending':'')}><Icon name={step.status==='completed'?'circle-check':step.status==='running'?'loader-circle':step.status==='failed'?'circle-alert':'circle-dashed'}/><span dir="auto">{step.title}<small> · {step.status}</small></span></div>)}</section>}{fixture&&<section className="ec-inspectsection"><div className="ec-inspecttitle">Plan <span className="ec-subtle">{final?'3':'2'} / 3</span></div>{['Inspect the current behavior',work.id==='retry'?'Implement bounded retries':'Review the available evidence',work.id==='retry'?'Verify with focused tests':'Summarize findings and limits'].map((step,index)=><div key={step} className={'ec-plan '+(index===2&&!final?'ec-pending':'')}><Icon name={index===2&&!final?'circle-dashed':'circle-check'}/><span>{step}</span></div>)}</section>}<section className="ec-inspectsection"><div className="ec-inspecttitle">Execution</div><dl><div className="ec-kv"><dt>Workspace</dt><dd className="ec-target"><Icon name="folder"/><bdi>{work.target?.label??'Unbound'}</bdi></dd></div>{fixture&&<div className="ec-kv"><dt>Working branch</dt><dd className="ec-branch">{work.id==='retry'?'ame/billing-retries':'main'}</dd></div>}<div className="ec-kv"><dt>Environment</dt><dd>{work.target?.isolation==='host'?'Local host':work.target?.isolation==='sandboxed'?'Sandboxed target':'Unknown'}</dd><dd className="ec-subtle">{work.target?.isolation==='host'?'Not sandboxed':''}</dd></div><div className="ec-kv"><dt>{fixture?'Model':work.kind==='task'?'Next attempt model':'Next turn model'}</dt><dd><bdi>{fixture?'Kimi K3':execution?.model??'Unavailable'}</bdi></dd></div><div className="ec-kv"><dt>{fixture?'Approval mode':'Profile approval mode'}</dt><dd>{fixture?'Strict':execution?.target?.approvalMode??'Unavailable'}</dd></div></dl></section>{!fixture&&api?<WorkUsage key={work.profileId+work.id} api={api} work={work}/>:<section className="ec-inspectsection"><div className="ec-inspecttitle">Usage {fixture&&<span className="ec-subtle">Sample</span>}</div><dl><div className="ec-kv"><dt>Reported tokens</dt><dd>{fixture?'8,420':'Unavailable'}</dd></div><div className="ec-kv"><dt>Cost estimate</dt><dd className="ec-subtle">Unavailable</dd></div></dl></section>}</aside>;
}
