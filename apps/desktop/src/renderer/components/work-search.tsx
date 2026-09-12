import {useI18n} from '../i18n.js';
import {useEffect,useRef,useState} from 'react';
import type {Page,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopWorkApi} from '../../shared/desktop-api.js';
import {Button,Icon,Topline} from './primitives.js';
import {statusLabel} from './sidebar.js';
export function WorkSearch({api,query,change,select}:{api:DesktopWorkApi;query:string;change:(value:string)=>void;select:(id:string)=>void}){
 const {t,owned,status}=useI18n();
 const [page,setPage]=useState<Page<WorkProjection>>({items:[],nextCursor:null}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const epoch=useRef(0);
 useEffect(()=>{const current=++epoch.current;setPage({items:[],nextCursor:null});setError('');setBusy(true);const timer=setTimeout(()=>{void api.search(query).then(result=>{if(epoch.current===current)setPage(result);}).catch(()=>{if(epoch.current===current)setError('Search is unavailable. Try again when connected.');}).finally(()=>{if(epoch.current===current)setBusy(false);});},200);return()=>{clearTimeout(timer);epoch.current++;};},[api,query]);
 const more=async()=>{const current=epoch.current;setBusy(true);try{const result=await api.search(query,page.nextCursor!);if(current===epoch.current)setPage(previous=>({items:[...previous.items,...result.items],nextCursor:result.nextCursor}));}catch{if(current===epoch.current)setError('Work changed. Edit the search to refresh results.');}finally{if(current===epoch.current)setBusy(false);}};
 return <><Topline label={t("Search")}/><div className="ec-page"><h1>{t("Find your work.")}</h1><div className="ec-searchfield"><Icon name="search"/><input type="search" aria-label={t("Search chats")} placeholder={t("Search titles, workspaces, or IDs…")} autoFocus maxLength={200} value={query} onChange={event=>change(event.target.value)}/></div>{page.items.map(item=><button key={item.id} className="ec-searchresult" onClick={()=>select(item.id)}><Icon name="message-square"/><span><bdi>{item.title}</bdi><small><bdi>{item.target?.label??t("Unbound target")}</bdi> · {owned(statusLabel(item))}</small></span><Icon name="arrow-up-right"/></button>)}{busy&&<p role="status">{t("Searching…")}</p>}{error&&<p role="alert">{owned(error)}</p>}{!busy&&!error&&!page.items.length&&<p>{t("No matching Work.")}</p>}{page.nextCursor&&<Button disabled={busy||!!error||page.items.length>=2000} onClick={()=>void more()}>{page.items.length>=2000?t("First 2,000 matches shown"):t("More matches")}</Button>}</div></>;
}
