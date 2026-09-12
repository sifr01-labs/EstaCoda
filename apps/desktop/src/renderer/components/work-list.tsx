import {useI18n} from '../i18n.js';
import {useState} from 'react';
import type {WorkProjection} from '@estacoda/control-protocol';
import {Button,Icon,Topline} from './primitives.js';
import {statusLabel} from './sidebar.js';

/** Filtering only describes the inspected page; pagination stays explicit. */
export function WorkList({items,select,more,loading,limited}:{items:WorkProjection[];select:(id:string)=>void;more?:()=>void;loading:boolean;limited:boolean}) {
 const {t,owned,status}=useI18n();
 const [filter,setFilter]=useState('all');
 const visible=items.filter(item=>filter==='all'||(filter==='active'?['queued','running','needs_attention','paused'].includes(item.status):item.kind===filter));
 return <><Topline label={t("Work")}/><div className="ec-page"><h1>{t("Your work.")}</h1><p className="ec-pageintro">{t("Conversations and durable Tasks in this profile.")}</p><label>{t("Show")+" "}<select aria-label={t("Filter Work")} value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">{t("All Work")}</option><option value="active">{t("Active Work")}</option><option value="session">{t("Conversations")}</option><option value="task">{t("Tasks")}</option></select></label>{visible.map(item=><button className="ec-searchresult" key={item.id} onClick={()=>select(item.id)}><Icon name={item.kind==='task'?'layers-2':'message-square'}/><span><bdi>{item.title}</bdi><small><bdi>{item.target?.label??t("Unbound target")}</bdi> · {owned(statusLabel(item))}</small></span><Icon name="arrow-up-right"/></button>)}{!visible.length&&<p className="ec-footnote">{t("No matching Work in the loaded results.")}</p>}{more&&<Button disabled={loading||limited} onClick={more}>{limited?t("First 2,000 Work items shown"):loading?t("Loading…"):t("Load more Work")}</Button>}</div></>;
}
