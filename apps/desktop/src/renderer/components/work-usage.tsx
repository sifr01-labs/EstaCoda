import {useI18n} from '../i18n.js';
import {useEffect,useState} from 'react';
import type {WorkProjection,WorkUsageProjection} from '@estacoda/control-protocol';
import type {DesktopWorkApi} from '../../shared/desktop-api.js';
export function WorkUsage({api,work}:{api:DesktopWorkApi;work:WorkProjection}){
 const {t,owned}=useI18n();
 const[value,setValue]=useState<WorkUsageProjection|null>(null),[error,setError]=useState(false);
 useEffect(()=>{if(!api.usage||!['session','task','task_attempt'].includes(work.kind))return;let active=true;void api.usage(work.id).then(result=>{if(active){setValue(result);setError(false);}},()=>{if(active){setValue(null);setError(true);}});return()=>{active=false;};},[api,work]);
 const number=(n:number)=>n.toLocaleString();
 return <section className="ec-inspectsection" aria-label={t("Canonical Work usage")}><div className="ec-inspecttitle">{t("Usage")}</div><dl><div className="ec-kv"><dt>{t("Reported tokens")}{value&&!value.usageComplete?" "+t("· partial"):''}</dt><dd>{value?.reportedTokens==null?t("Unavailable"):number(value.reportedTokens)}</dd></div><div className="ec-kv"><dt>{t("Cost estimate")}{value&&!value.pricingComplete?" "+t("· partial"):''}</dt><dd>{value?.cost?new Intl.NumberFormat(undefined,{style:'currency',currency:value.cost.currency,maximumFractionDigits:4}).format(value.cost.amount):t("Unavailable")}</dd></div><div className="ec-kv"><dt>{t("Reported provider calls")}</dt><dd>{value?number(value.providerCalls):t("Unavailable")}</dd></div><div className="ec-kv"><dt>{t("Context window")}</dt><dd>{value?.context?number(value.context.usedTokens)+' / '+number(value.context.totalTokens):t("Unavailable")}</dd>{value?.context&&<dd><bdi>{value.context.provider} / {value.context.model}</bdi></dd>}</div></dl><p className="ec-footnote">{error?t("Usage could not be refreshed."):value?.provisional?t("Latest settled calls; active Work can add usage."):t("Reported usage from settled provider calls.")}{value?.truncated?" "+t("Inspection limit reached; totals shown are lower bounds."):''}</p></section>;
}
