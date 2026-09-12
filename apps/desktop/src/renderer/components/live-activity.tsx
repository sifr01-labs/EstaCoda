import {useI18n} from '../i18n.js';
import {useEffect,useState} from 'react';
import type {MethodContracts,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopWorkApi} from '../../shared/desktop-api.js';
/** One outstanding selected-Work read. Reconnect replaces previews with canonical history. */
export function LiveActivity({api,work}:{api:DesktopWorkApi;work:WorkProjection}){
 const {t,owned}=useI18n();
 const[preview,setPreview]=useState<MethodContracts['work.live']['result']|null>(null);
 useEffect(()=>{if(work.kind!=='session'||!work.target||!api.live)return;let active=true;let timer:ReturnType<typeof setTimeout>;
 const poll=async()=>{try{const next=await api.live(work.id);if(active)setPreview(next);}catch{if(active)setPreview(null);}finally{if(active)timer=setTimeout(()=>void poll(),1000);}};
 void poll();return()=>{active=false;clearTimeout(timer);};},[api,work.id,work.target?.targetGeneration]);
 if(!preview?.active)return null;
 return <section className="ec-agent" aria-label={t("Live assistant activity")} aria-busy="true"><div className="ec-msghead"><b>EstaCoda</b><span>{t("Working…")}</span></div>{preview.text&&<div dir="auto" style={{whiteSpace:'pre-wrap'}}>{preview.text}</div>}{preview.truncated&&<p className="ec-footnote">{t("Live preview limit reached. The settled response will appear in activity.")}</p>}</section>;
}
