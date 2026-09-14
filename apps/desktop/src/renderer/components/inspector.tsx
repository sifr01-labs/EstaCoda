import {RuntimeDetails} from './runtime-details.js';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {useEffect,useState} from 'react';
import type {Draft} from '../app.js';
import type {DesktopModelsApi} from '../../shared/desktop-api.js';
import type {TargetProjection} from '@estacoda/control-protocol';
import type{DesktopWorkApi}from'../../shared/desktop-api.js';
import{WorkUsage}from'./work-usage.js';
import type{ActivityProjection,WorkProjection}from'@estacoda/control-protocol';
import type{FixturePhase}from'../adapter.js';import{Icon}from'./primitives.js';
export function Inspector({work,fixture,phase,plan,api,models,draft,runtimeApi}:{runtimeApi?:DesktopApi;models?:DesktopModelsApi;draft?:Draft;api?:DesktopWorkApi;plan?:Extract<ActivityProjection,{kind:'plan'}>;work?:WorkProjection;fixture:boolean;phase?:FixturePhase}){
 const {t,owned,status}=useI18n();
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
    if(!cancelled)setExecution({target,model:work&&!work.modelBinding?t("Unavailable"):selected?catalog.items.find(row=>row.providerId===selected.providerId&&row.id===selected.modelId)?.label??selected.modelId:primary?primary.label:t("Unavailable")});
   }catch{if(!cancelled)setExecution(null);}
  };
  setExecution(null);void refresh();const timer=setInterval(()=>void refresh(),3000);
  return()=>{cancelled=true;clearInterval(timer);};
 },[api,models,fixture,work?.id,work?.profileId,draft?.target?.targetId,draft?.target?.targetGeneration,draft?.modelSelection?.providerId,draft?.modelSelection?.modelId]);
 if(!work)return <aside className="ec-inspector" aria-label={t("Draft details")}><h3>{t("New chat")}</h3><p className="ec-footnote">{fixture?<>{t("Local host · not sandboxed")}<br/>{t("Strict approval mode")}<br/>{t("Nothing is running.")}</>:draft?.target?<><bdi>{execution?.target?.label??t("Selected workspace")}</bdi><br/>{execution?.target?.isolation==='host'?t("Local host · not sandboxed"):t("Isolation unavailable")}<br/>{t("Profile approval mode:")+" "}{execution?.target?.approvalMode?status(execution.target.approvalMode):t("Unavailable")}<br/>{t("Model")}: <bdi>{execution?.model??t("Unavailable")}</bdi><br/>{t("Nothing is running.")}</>:t("No execution target is selected.")}</p>{!fixture&&<section id="ec-operation-details" className="ec-inspectsection"/>}</aside>;
 const final=work.id!=='retry'||phase==='done';
 return <aside className="ec-inspector" aria-label={t("Work details")}>{!fixture&&plan&&<section className="ec-inspectsection"><div className="ec-inspecttitle">{t("Plan")+" "}<span className="ec-subtle">{plan.steps.filter(step=>step.status==='completed').length} / {plan.steps.length}</span></div>{plan.steps.map(step=><div key={step.id} className={'ec-plan '+(step.status==='pending'?'ec-pending':'')}><Icon name={step.status==='completed'?'circle-check':step.status==='running'?'loader-circle':step.status==='failed'?'circle-alert':'circle-dashed'}/><span dir="auto">{step.title}<small> · {status(step.status)}</small></span></div>)}</section>}{fixture&&<section className="ec-inspectsection"><div className="ec-inspecttitle">{t("Plan")+" "}<span className="ec-subtle">{final?'3':'2'} / 3</span></div>{[t("Inspect the current behavior"),work.id==='retry'?t("Implement bounded retries"):t("Review the available evidence"),work.id==='retry'?t("Verify with focused tests"):t("Summarize findings and limits")].map((step,index)=><div key={step} className={'ec-plan '+(index===2&&!final?'ec-pending':'')}><Icon name={index===2&&!final?'circle-dashed':'circle-check'}/><span>{step}</span></div>)}</section>}<section className="ec-inspectsection"><div className="ec-inspecttitle">{t("Execution")}</div>{!fixture&&<details><summary>{t("Work ID")}</summary><code className="ec-identity" dir="ltr">{work.canonicalId}</code><button type="button" className="ec-btn ec-ghost" onClick={event=>{const button=event.currentTarget;void navigator.clipboard.writeText(work.canonicalId).then(()=>{button.textContent=t("Copied");},()=>{button.textContent=t("Copy unavailable");});}}>{t("Copy ID")}</button></details>}<dl><div className="ec-kv"><dt>{t("Workspace")}</dt><dd className="ec-target"><Icon name="folder"/><bdi>{work.target?.label??t("Unbound")}</bdi></dd></div>{fixture&&<div className="ec-kv"><dt>{t("Working branch")}</dt><dd className="ec-branch">{work.id==='retry'?'ame/billing-retries':'main'}</dd></div>}{fixture?<div className="ec-kv"><dt>{t("Environment")}</dt><dd>{t("Local host")}</dd><dd className="ec-subtle">{t("Not sandboxed")}</dd></div>:<>{runtimeApi&&<RuntimeDetails api={runtimeApi} profile={work.profileId}/>} {(execution?.target?.isolation==='host'||execution?.target?.isolation==='sandboxed')&&<div className="ec-kv"><dt>{t("Isolation")}</dt><dd>{t(execution.target.isolation==='host'?"Not sandboxed":"Sandboxed target")}</dd></div>}</>}<div className="ec-kv"><dt title={!fixture?t("Model selection applies to the next message or attempt."):undefined}>{t("Model")}</dt><dd><bdi>{fixture?'Kimi K3':execution?.model??t("Unavailable")}</bdi></dd></div><div className="ec-kv"><dt>{fixture?t("Approval mode"):t("Profile approval mode")}</dt><dd>{fixture?t("Strict"):execution?.target?.approvalMode?status(execution.target.approvalMode):t("Unavailable")}</dd></div></dl></section>{!fixture&&api?<WorkUsage key={work.profileId+work.id} api={api} work={work}/>:<section className="ec-inspectsection"><div className="ec-inspecttitle">{t("Usage")+" "}{fixture&&<span className="ec-subtle">{t("Sample")}</span>}</div><dl><div className="ec-kv"><dt>{t("Reported tokens")}</dt><dd>{fixture?'8,420':t("Unavailable")}</dd></div><div className="ec-kv"><dt>{t("Cost estimate")}</dt><dd className="ec-subtle">{t("Unavailable")}</dd></div></dl></section>}{!fixture&&<section id="ec-operation-details" className="ec-inspectsection"/>}</aside>;
}
