import {useState} from 'react';
import type {WorkProjection} from '@estacoda/control-protocol';
import {Button,Icon,Topline} from './primitives.js';
import {statusLabel} from './sidebar.js';

/** Filtering only describes the inspected page; pagination stays explicit. */
export function WorkList({items,select,more,loading,limited}:{items:WorkProjection[];select:(id:string)=>void;more?:()=>void;loading:boolean;limited:boolean}) {
 const [filter,setFilter]=useState('all');
 const visible=items.filter(item=>filter==='all'||(filter==='active'?['queued','running','needs_attention','paused'].includes(item.status):item.kind===filter));
 return <><Topline label="Work"/><div className="ec-page"><h1>Your work.</h1><p className="ec-pageintro">Conversations and durable Tasks in this profile.</p><label>Show <select aria-label="Filter Work" value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">All Work</option><option value="active">Active Work</option><option value="session">Conversations</option><option value="task">Tasks</option></select></label>{visible.map(item=><button className="ec-searchresult" key={item.id} onClick={()=>select(item.id)}><Icon name={item.kind==='task'?'layers-2':'message-square'}/><span><bdi>{item.title}</bdi><small><bdi>{item.target?.label??'Unbound target'}</bdi> · {statusLabel(item)}</small></span><Icon name="arrow-up-right"/></button>)}{!visible.length&&<p className="ec-footnote">No matching Work in the loaded results.</p>}{more&&<Button disabled={loading||limited} onClick={more}>{limited?'First 2,000 Work items shown':loading?'Loading…':'Load more Work'}</Button>}</div></>;
}
