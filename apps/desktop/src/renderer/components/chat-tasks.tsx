import {useEffect,useRef,useState} from 'react';
import type {WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {Button,Icon} from './primitives.js';
import {statusLabel} from './sidebar.js';
import {WorkActions} from './work-actions.js';
import {EvidenceView} from './evidence-view.js';

/** Uses canonical projections and existing fenced actions, never a renderer-owned task state. */
export function ChatTasks({api,work,select,summary=false,openTasks,results=false}:{api:DesktopApi;work:WorkProjection;select:(id:string)=>void;summary?:boolean;openTasks?:()=>void;results?:boolean}){
 const {t,owned,status}=useI18n();
 const [tasks,setTasks]=useState<WorkProjection[]>([]),[error,setError]=useState(''),[more,setMore]=useState(false),[busy,setBusy]=useState(true);
 const [resultId,setResultId]=useState<string|null>(null),[guidance,setGuidance]=useState(''),[notice,setNotice]=useState('');
 const epoch=useRef(0);
 const [retryStep,setRetryStep]=useState<string|null>(null),[acting,setActing]=useState(false);
 useEffect(()=>{const current=++epoch.current;setError('');setBusy(true);void(async()=>{
  if(work.kind==='task')return[work];
  const page=await api.work!.children(work.id);while(page.nextCursor&&page.items.length<200){const next=await api.work!.children(work.id,page.nextCursor);page.items.push(...next.items);page.nextCursor=next.nextCursor;}
  if(current===epoch.current)setMore(!!page.nextCursor);return page.items.filter(item=>item.kind==='task');
 })().then(items=>{if(current===epoch.current)setTasks(items);},()=>{if(current===epoch.current)setError('Tasks could not be loaded.');}).finally(()=>{if(current===epoch.current)setBusy(false);});return()=>{epoch.current++;};},[api,work]);
 if(summary)return tasks.length?<button className="ec-chat-task-summary" onClick={openTasks}><Icon name="layers-2"/><span><b>{t('Tasks')} · {tasks.length}</b><small>{tasks.map(task=>owned(statusLabel(task))).join(' · ')}</small></span><Icon name="chevron-right"/></button>:null;
 const retry=async(task:WorkProjection,stepId:string)=>{if(acting)return;setActing(true);setNotice('');try{const receipt=await api.work!.act({workId:task.id,action:'tasks.retry',stepId});setNotice(['accepted','dispatched','completed'].includes(receipt.state)?'Retry requested.':'Retry not confirmed. Check execution status.');setRetryStep(null);}catch{setNotice('Retry not confirmed. Check execution status.');}finally{setActing(false);}};
 const guide=async(task:WorkProjection)=>{if(acting||!guidance.trim())return;setActing(true);setNotice('');try{const receipt=await api.work!.act({workId:task.id,action:'tasks.guide',guidance});setNotice(['accepted','dispatched','completed'].includes(receipt.state)?'Guidance received.':'Guidance not confirmed. Check execution status.');setGuidance('');}catch{setNotice('Guidance not confirmed. Check execution status.');}finally{setActing(false);}};
 return <section className="ec-chat-tasks" aria-label={t('Tasks')}>
 {error&&<p role="alert">{owned(error)}</p>}{busy&&!tasks.length&&<p role="status">{t('Loading…')}</p>}
 {!busy&&!tasks.length&&!error&&<div className="ec-empty"><Icon name="layers-2"/><h2>{t('No tasks in this conversation')}</h2><p>{t('Delegated work will appear here. Updates and results stay in your conversation.')}</p></div>}
 {tasks.map(task=><article className="ec-chat-task" key={task.id}>
 <header className="ec-chat-task-heading"><div><span className="ec-sectionlabel">{t('Task')}</span><h2 dir="auto">{task.title}</h2></div><span className="ec-task-state"><Icon name={task.status==='completed'?'circle-check':task.status==='running'?'loader-circle':'circle-alert'}/>{owned(statusLabel(task))}</span></header>
 {task.taskProgress?.fileOutput&&<p className="ec-footnote"><bdi>{task.taskProgress.fileOutput}</bdi> · {t(task.taskProgress.fileVerified?'Saved and verified':'Not saved and verified by this task')}</p>}
 {task.taskProgress?.steps.some(step=>step.role==='synthesis')&&!results&&<ol className="ec-task-stages">{([['worker','Research'],['synthesis','Synthesize'],['report-delivery','Save and verify']] as const).filter(([role])=>task.taskProgress!.steps.some(step=>step.role===role)).map(([role,label])=>{const stages=task.taskProgress!.steps.filter(step=>step.role===role);const accepted=stages.filter(step=>step.accepted&&step.status==='completed').length;return <li key={role} data-complete={accepted===stages.length}>{t(label!)}<small>{accepted} / {stages.length} {t('accepted')}</small></li>;})}</ol>}
 {results?<EvidenceView api={api} work={task}/>:<>
 {task.reason&&<p className="ec-notice" dir="auto">{task.reason}</p>}
 {task.taskProgress?.steps.map(step=><details className="ec-task-worker" key={step.id}><summary><Icon name={step.accepted?'circle-check':step.status==='running'?'loader-circle':['failed','waiting_for_input'].includes(step.status)?'circle-alert':'circle-dashed'}/><span><bdi>{step.title}</bdi><small>{t(step.role==='worker'?'Research':step.role==='synthesis'?'Synthesize':step.role==='report-delivery'?'Save and verify':'Task')} · {step.accepted?t('Accepted'):status(step.status==='waiting_for_input'?'needs_attention':step.status==='waiting_for_approval'?'approval_required':step.status)}</small></span><Icon name="chevron-down"/></summary><div className="ec-task-worker-detail"><p>{t('Attempts')}: {step.attempts}</p>{step.reason&&<p dir="auto">{step.reason}</p>}{step.diagnostic&&<p>{t('A draft is preserved for inspection. It has not been accepted as a result.')}</p>}{step.attemptWorkId&&<Button className="ec-ghost" onClick={()=>select(step.attemptWorkId!)}>{t('Inspect attempt')}</Button>}{task.actions?.filter(action=>action.id==='tasks.retry'&&action.stepId===step.id).map(action=><span key={action.stepId}><Button disabled={acting||!action.enabled} onClick={()=>setRetryStep(step.id)}>{t('Review retry')}</Button>{!action.enabled&&action.reason&&<p dir="auto">{owned(action.reason)}</p>}</span>)}{retryStep===step.id&&<section className="ec-task-recovery"><h3>{t('Retry this step')}</h3><p>{t('Accepted results are preserved. Only this step will run again, using the existing task permissions and remaining limits.')}</p><div className="ec-actions"><Button disabled={acting} onClick={()=>setRetryStep(null)}>{t('Cancel')}</Button><Button className="ec-primary" disabled={acting} onClick={()=>void retry(task,step.id)}>{t('Retry this step')}</Button></div></section>}</div></details>)}
 {task.taskProgress?.truncated&&<p>{t('Only the first 64 steps are shown.')}</p>}
 <div className="ec-actions"><Button onClick={()=>setResultId(resultId===task.id?null:task.id)}>{t(resultId===task.id?'Hide results':'View results')}</Button><Button className="ec-ghost" onClick={()=>select(task.id)}>{t('Open task details')}</Button></div>
 {resultId===task.id&&<EvidenceView api={api} work={task}/>}
 {api.work&&<WorkActions api={api.work} work={{...task,actions:task.actions?.filter(action=>action.id!=="tasks.retry")}}/>}
 {task.actions?.some(action=>action.id==='tasks.guide'&&action.enabled)&&<form className="ec-task-guidance" onSubmit={event=>{event.preventDefault();void guide(task);}}><label>{t('Guide this task')}<textarea value={guidance} maxLength={4000} onChange={event=>setGuidance(event.target.value)} placeholder={t('Add direction without starting another task')}/></label><Button type="submit" disabled={acting||!guidance.trim()}>{t('Send guidance')}</Button></form>}
 </>}
 </article>)}{notice&&<p role="status">{owned(notice)}</p>}{more&&<p>{t('More tasks are available in Work.')}</p>}
 </section>;
}
