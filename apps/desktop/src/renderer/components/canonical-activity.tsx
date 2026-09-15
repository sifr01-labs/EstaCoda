import {MessageActions} from './message-actions.js';
import type {ActivityProjection} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {BrandEye,Button,Icon} from './primitives.js';
import {ResponseMarkdown} from './response-markdown.js';
const browserLabels:Record<string,string>={'browser.navigate':'Open page','browser.status':'Check browser readiness','browser.snapshot':'Inspect page','browser.find':'Find on page','browser.click':'Click page element','browser.type':'Enter field value','browser.fill_protected_form':'Secure credential entry','browser.screenshot':'Capture page'};
type Tool=Extract<ActivityProjection,{kind:'tool'}>;
function ToolActivity({items}:{items:Tool[]}){
 const {t,status,owned}=useI18n();const failed=items.some(item=>item.state==='failed');
 return <details className="ec-toolactivity" open={failed||undefined}><summary><Icon name={failed?'circle-alert':'layers-2'}/><span>{items.every(item=>item.name.startsWith('browser.'))?t('Browser activity'):t('Tool activity')}</span><small>{t('{count} updates',{count:items.length})}</small><Icon name="chevron-down"/></summary><div>{items.map(item=><div className={'ec-toolrow '+(item.state==='failed'?'ec-toolfailed':'')} key={item.id}><Icon name={item.state==='running'?'clock-3' :item.state==='completed'?'check':item.state==='cancelled'?'square':'circle-alert'}/><div><span>{browserLabels[item.name]?owned(browserLabels[item.name]!):<bdi>{item.name}</bdi>}</span><small>{item.state==='running'?t('Started'):status(item.state)}</small><details><summary>{t('Technical details')}</summary><bdi>{item.name}</bdi><p dir="auto">{item.summary}</p></details></div>{item.timestamp>0&&<time>{new Date(item.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>}</div>)}</div></details>;
}
/** Group only adjacent tool records. Never invent call counts, arguments, or verified effects. */
export function CanonicalActivity({items,results,browser}:{items:ActivityProjection[];results:()=>void;browser?:()=>void}){
 const {t,status}=useI18n();const groups:Array<ActivityProjection|Tool[]>=[];
 for(const item of items){const last=groups.at(-1);if(item.kind==='tool'){if(Array.isArray(last))last.push(item);else groups.push([item]);}else groups.push(item);}
 let identityShown=false;const hasBrowser=items.some(item=>item.kind==='tool'&&item.name.startsWith('browser.'));
 return <>{groups.map(item=>{
  if(Array.isArray(item))return <ToolActivity key={item[0]!.id} items={item}/>;
  if(item.kind==='message'){const showIdentity=item.role==='assistant'&&!identityShown;if(item.role==='user')identityShown=false;else identityShown=true;return <section key={item.id} data-conversation-turn={item.role==='user'?item.id:undefined} aria-label={item.role==='user'?t("Your message"):undefined} className={item.role==='user'?'ec-usernote':'ec-agent'}><div className={"ec-msghead "+(!showIdentity?'ec-sr-only':'')}>{item.role==='assistant'&&<BrandEye/>}<b>{item.role==='user'?t('You'):'EstaCoda'}</b></div>{item.role==='user'?<div dir="auto" style={{whiteSpace:'pre-wrap'}}>{item.text}</div>:<ResponseMarkdown text={item.text}/>}<MessageActions text={item.text} timestamp={item.timestamp}/></section>;}
  if(item.kind==='assistant_delta')return <section className="ec-agent" key={item.id}><ResponseMarkdown text={item.text}/></section>;
  if(item.kind==='plan')return <details className="ec-toolactivity" key={item.id}><summary><Icon name="clipboard-list"/>{t('Plan')}<small>{item.steps.filter(step=>step.status==='completed').length} / {item.steps.length}</small></summary><ol>{item.steps.map(step=><li key={step.id}><span dir="auto">{step.title}</span> · {status(step.status)}</li>)}</ol></details>;
  if(item.kind==='result')return ['failed','partial','needs_attention','cancelled'].includes(item.status)?<div className="ec-activitynotice" key={item.id}><Icon name="circle-alert"/><span>{status(item.status)}</span><Button className="ec-ghost" onClick={results}>{t('View results')}</Button>{hasBrowser&&browser&&<Button className="ec-ghost" icon="globe" onClick={browser}>{t('Open browser')}</Button>}</div>:null;
  if(item.kind==='status'&&['failed','partial','needs_attention','paused','cancelled'].includes(item.status))return <div className="ec-activitynotice" key={item.id}><Icon name="circle-alert"/>{status(item.status)}{item.reason&&<span dir="auto">{item.reason}</span>}</div>;
  return null;
 })}</>;
}
