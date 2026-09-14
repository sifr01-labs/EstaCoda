import type {ActivityProjection} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {BrandEye,Button,Icon} from './primitives.js';
import {ResponseMarkdown} from './response-markdown.js';
type Tool=Extract<ActivityProjection,{kind:'tool'}>;
function ToolActivity({items}:{items:Tool[]}){
 const {t,status}=useI18n();const failed=items.some(item=>item.state==='failed');
 return <details className="ec-toolactivity" open={failed||undefined}><summary><Icon name={failed?'circle-alert':'layers-2'}/><span>{t('Tool activity')}</span><small>{t('{count} updates',{count:items.length})}</small><Icon name="chevron-down"/></summary><div>{items.map(item=><div className={'ec-toolrow '+(item.state==='failed'?'ec-toolfailed':'')} key={item.id}><Icon name={item.state==='running'?'loader-circle':item.state==='completed'?'check':item.state==='cancelled'?'square':'circle-alert'}/><div><bdi>{item.name}</bdi><small>{status(item.state)}</small><p dir="auto">{item.summary}</p></div>{item.timestamp>0&&<time>{new Date(item.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>}</div>)}</div></details>;
}
/** Group only adjacent tool records. Never invent call counts, arguments, or verified effects. */
export function CanonicalActivity({items,results}:{items:ActivityProjection[];results:()=>void}){
 const {t,status}=useI18n();const groups:Array<ActivityProjection|Tool[]>=[];
 for(const item of items){const last=groups.at(-1);if(item.kind==='tool'){if(Array.isArray(last))last.push(item);else groups.push([item]);}else groups.push(item);}
 return <>{groups.map(item=>{
  if(Array.isArray(item))return <ToolActivity key={item[0]!.id} items={item}/>;
  if(item.kind==='message')return <section key={item.id} className={item.role==='user'?'ec-usernote':'ec-agent'}><div className="ec-msghead">{item.role==='assistant'&&<BrandEye/>}<b>{item.role==='user'?t('You'):'EstaCoda'}</b></div>{item.role==='user'?<div dir="auto" style={{whiteSpace:'pre-wrap'}}>{item.text}</div>:<ResponseMarkdown text={item.text}/>}</section>;
  if(item.kind==='assistant_delta')return <section className="ec-agent" key={item.id}><ResponseMarkdown text={item.text}/></section>;
  if(item.kind==='plan')return <details className="ec-toolactivity" key={item.id}><summary><Icon name="clipboard-list"/>{t('Plan')}<small>{item.steps.filter(step=>step.status==='completed').length} / {item.steps.length}</small></summary><ol>{item.steps.map(step=><li key={step.id}><span dir="auto">{step.title}</span> · {status(step.status)}</li>)}</ol></details>;
  if(item.kind==='result')return ['failed','partial','needs_attention','cancelled'].includes(item.status)?<div className="ec-activitynotice" key={item.id}><Icon name="circle-alert"/><span>{status(item.status)}</span><Button className="ec-ghost" onClick={results}>{t('View results')}</Button></div>:null;
  if(item.kind==='status'&&['failed','partial','needs_attention','paused','cancelled'].includes(item.status))return <div className="ec-activitynotice" key={item.id}><Icon name="circle-alert"/>{status(item.status)}{item.reason&&<span dir="auto">{item.reason}</span>}</div>;
  return null;
 })}</>;
}
