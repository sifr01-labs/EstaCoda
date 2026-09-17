import type {ActivityProjection,WorkDisplayStatus} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import type {MessageKey} from '../../shared/i18n/index.js';
import {activityRuns,runContent,type ActivityRun,type ToolAction} from '../conversation-activity.js';
import {useI18n} from '../i18n.js';
import {MessageActions} from './message-actions.js';
import {BrandEye,Button,Icon} from './primitives.js';
import {ResponseMarkdown} from './response-markdown.js';
import {RunOutputs} from './run-outputs.js';
import '../styles/conversation-activity.css';
const toolLabels:Record<string,MessageKey>={
 'browser.navigate':'Open page','browser.status':'Check browser readiness','browser.snapshot':'Inspect page','browser.find':'Find on page',
 'browser.click':'Click page element','browser.type':'Enter field value','browser.fill_protected_form':'Secure credential entry','browser.screenshot':'Capture page',
 'browser.download':'Download file','files.read':'Read file','files.write':'Write file','files.edit':'Edit file','files.list':'List files','files.search':'Search files',
 'shell.exec':'Run command','terminal.exec':'Run command','web.search':'Search the web','web.extract':'Read webpage','plan.update':'Update plan',
 'file.read':'Read file','file.write':'Write file','file.patch':'Edit file','file.search':'Search files','file.grep':'Search files','file.glob':'List files',
 'terminal.run':'Run command','plan':'Update plan','browser.extract':'Read webpage',
};
function actionLabel(name:string):MessageKey{return toolLabels[name]??(name.startsWith('mcp.')?'Use connector':'Tool action');}
function RecordedTime({value}:{value:number}){const {t,language}=useI18n();if(!value)return null;const date=new Date(value);const time=date.toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit',second:'2-digit'});return <time dateTime={date.toISOString()} title={t('Recorded at {time}',{time})}>{time}</time>;}
function Action({action,active}:{action:ToolAction;active:boolean}){
 const {t,status}=useI18n();const first=action.records[0]!,last=action.records.at(-1)!;
 const label=last.state==='running'?t(active?'Started':'Result not recorded'):status(last.state);
 const elapsed=first!==last&&last.timestamp>=first.timestamp&&first.timestamp>0?Math.round((last.timestamp-first.timestamp)/1000):null;
 return <details className={'ec-run-action '+(last.state==='failed'?'ec-run-failure':'')}><summary><Icon name={last.state==='completed'?'check':last.state==='failed'?'circle-alert':last.state==='cancelled'?'square':'clock-3'}/><span className="ec-run-actiontitle">{t(actionLabel(last.name))}<small>{label}{!toolLabels[last.name]&&<> · <bdi>{last.name}</bdi></>}</small></span><RecordedTime value={last.timestamp}/><Icon name="chevron-right"/></summary><div className="ec-run-actiondetail"><bdi className="ec-run-toolname">{last.name}</bdi>{elapsed!==null&&<small>{t('Elapsed: {seconds}s',{seconds:elapsed})}</small>}<div className="ec-run-attempts">{action.records.map(record=><div key={record.id}><RecordedTime value={record.timestamp}/><span><strong>{record.state==='running'?t('Started'):status(record.state)}</strong><p dir="auto">{['Tool started','Tool completed','Tool failed'].includes(record.summary)?t(record.summary as MessageKey):record.summary}</p></span></div>)}</div></div></details>;
}
function Plan({item}:{item:Extract<ActivityProjection,{kind:'plan'}>}){const {t,status}=useI18n();return <details className="ec-run-plan"><summary><Icon name="clipboard-list"/><span>{t('Plan')}</span><small>{t('Completed steps: {done} of {total}',{done:item.steps.filter(step=>step.status==='completed').length,total:item.steps.length})}</small><Icon name="chevron-right"/></summary><ol>{item.steps.map(step=><li key={step.id}><Icon name={step.status==='completed'?'check':step.status==='running'?'clock-3':step.status==='failed'?'circle-alert':'circle-dashed'}/><span dir="auto">{step.title}</span><small>{status(step.status)}</small></li>)}</ol></details>;}
function History({run,active,more}:{run:ActivityRun;active:boolean;more:boolean}){
 const {t,status}=useI18n();const content=runContent(run),{actions,plans,outcome,outputs}=content;
 const failed=actions.reduce((count,action)=>count+action.records.filter(record=>record.state==='failed').length,0);
 const actionById=new Map(actions.map(action=>[action.id,action]));
 const hasUnknown=actions.some(action=>!action.records[0]?.callId);
 const lastStatus=run.items.filter((item):item is Extract<ActivityProjection,{kind:'status'}>=>item.kind==='status').at(-1);
 const needsAttention=outcome?['partial','failed','needs_attention','cancelled'].includes(outcome.status):lastStatus?['partial','failed','needs_attention','paused','cancelled'].includes(lastStatus.status):failed>0;
 const current=actions.filter(action=>action.records.at(-1)?.state==='running').at(-1)?.records.at(-1);
 const title=active?(current?(toolLabels[current.name]?t(toolLabels[current.name]!):current.name):t('Activity')):needsAttention?status(outcome?.status??lastStatus?.status??'needs_attention'):t('Activity');
 const terminal=outcome??lastStatus;
 const firstTime=run.user?.timestamp??run.items[0]?.timestamp;
 const seconds=terminal&&firstTime&&terminal.timestamp>=firstTime?Math.round((terminal.timestamp-firstTime)/1000):null;
 const summary=[actions.length?t(hasUnknown?(actions.reduce((n,a)=>n+a.records.length,0)===1?'1 tool event':'{count} tool events'):(actions.length===1?'1 tool call':'{count} tool calls'),{count:hasUnknown?actions.reduce((n,a)=>n+a.records.length,0):actions.length}):null,outputs.length?t(outputs.length===1?'1 saved output':'{count} saved outputs',{count:outputs.length}):null,failed?t(failed===1?'1 failed attempt':'{count} failed attempts',{count:failed}):null].filter(Boolean).join(' · ');
 return <details className={'ec-run-history '+(needsAttention?'ec-run-needs-attention':'')}><summary className="ec-run-summary"><Icon name={active?'loader-circle':needsAttention?'circle-alert':outcome?.status==='completed'?'circle-check':'activity'}/><span><strong><bdi>{title}</bdi></strong><small>{summary||t('Recorded activity')}</small>{outcome?.recoveredErrors&&<small className="ec-run-recovered">{t('Recovered errors recorded')}</small>}</span>{seconds!==null&&<time title={t('Recorded span')}>{t('{minutes}m {seconds}s',{minutes:Math.floor(seconds/60),seconds:seconds%60})}</time>}<Icon name="chevron-right"/></summary><div className="ec-run-historybody"><div className="ec-run-historylabel">{t('Activity history')}{more&&<span>{t('More activity is available. Load it below to see the remaining history.')}</span>}</div>{plans.at(-1)&&<Plan item={plans.at(-1)!}/>}{plans.length>1&&<details className="ec-run-earlierplans"><summary>{t('Earlier plan updates')} · {plans.length-1}</summary>{plans.slice(0,-1).map(plan=><Plan key={plan.id} item={plan}/>)}</details>}
 {run.items.map(item=>{
  if(item.kind==='tool'){const action=actionById.get(item.id);return action?<Action key={item.id} action={action} active={active}/>:null;}
  if(item.kind==='message'&&!content.responses.includes(item))return <details className="ec-run-progress" key={item.id}><summary><Icon name="message-square"/><span>{t('Progress update')}</span><RecordedTime value={item.timestamp}/><Icon name="chevron-right"/></summary><ResponseMarkdown text={item.text}/></details>;
  if(item.kind==='assistant_delta')return <div className="ec-run-progress" key={item.id}><ResponseMarkdown text={item.text}/></div>;
  if(item.kind==='artifact')return <div className="ec-run-saved" key={item.id}><Icon name="file-text"/><span><bdi>{item.label}</bdi><small>{t('Saved output')}</small></span><RecordedTime value={item.timestamp}/></div>;
  return null;
 })}</div></details>;
}
function Notices({items,results,browser}:{items:ActivityProjection[];results:()=>void;browser?:()=>void}){const {t,status}=useI18n();return <>{items.map(item=>item.kind==='result'&&['failed','partial','needs_attention','cancelled'].includes(item.status)?<div className="ec-activitynotice" key={item.id}><Icon name="circle-alert"/><span>{status(item.status)}</span><Button className="ec-ghost" onClick={results}>{t('View results')}</Button>{browser&&<Button className="ec-ghost" icon="globe" onClick={browser}>{t('Open browser')}</Button>}</div>:item.kind==='status'&&['failed','partial','needs_attention','paused','cancelled'].includes(item.status)?<div className="ec-activitynotice" key={item.id}><Icon name="circle-alert"/>{status(item.status)}{item.reason&&<span dir="auto">{item.reason}</span>}</div>:null)}</>;}
export function CanonicalActivity({items,results,browser,api,workStatus,more=false}:{items:ActivityProjection[];results:()=>void;browser?:()=>void;api?:DesktopApi;workStatus?:WorkDisplayStatus;more?:boolean}){
 const {t}=useI18n();const runs=activityRuns(items);const hasBrowser=items.some(item=>item.kind==='tool'&&item.name.startsWith('browser.'));
 return <div className="ec-conversation-runs">{runs.map((run,index)=>{const content=runContent(run),latest=index===runs.length-1;const active=latest&&!more&&workStatus==='running'&&!content.outcome;return <div className="ec-conversation-run" key={run.id}>
 {run.user&&<section className="ec-usernote" data-conversation-turn={run.user.id} aria-label={t('Your message')}><div dir="auto" style={{whiteSpace:'pre-wrap'}}>{run.user.text}</div><MessageActions text={run.user.text} timestamp={run.user.timestamp}/></section>}
 {!!run.items.length&&<section className="ec-agent"><div className="ec-msghead"><BrandEye/><b>EstaCoda</b></div>{content.operational&&<History run={run} active={active} more={latest&&more}/>}
 {content.responses.map(item=><section className="ec-run-answer" key={item.id}><ResponseMarkdown text={item.text}/>{item!==content.responses.at(-1)&&<MessageActions text={item.text} timestamp={item.timestamp}/>}</section>)}
 {active&&!content.responses.length&&content.latestProgress&&<div className="ec-run-currentprose"><ResponseMarkdown text={content.latestProgress.text}/></div>}
 {!content.operational&&run.items.filter(item=>item.kind==='assistant_delta').map(item=><ResponseMarkdown key={item.id} text={item.text}/>)}
 <Notices items={run.items} results={results} browser={hasBrowser?browser:undefined}/>
 {!!content.outputs.length&&<RunOutputs items={content.outputs} api={api} results={results}/ >}{content.responses.at(-1)&&<MessageActions text={content.responses.at(-1)!.text} timestamp={content.responses.at(-1)!.timestamp}/>}</section>}
 </div>;})}</div>;
}
