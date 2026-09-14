import {useI18n} from '../i18n.js';
import {useEffect,useState} from 'react';
import type {WorkProjection,WorkUsageProjection} from '@estacoda/control-protocol';
import type {DesktopWorkApi} from '../../shared/desktop-api.js';
import {compactNumber,compactCost,contextPercent} from '../usage-format.js';
export function WorkUsage({api,work,context=true}:{api:DesktopWorkApi;work:WorkProjection;context?:boolean}){
 const {t,language}=useI18n();
 const[value,setValue]=useState<WorkUsageProjection|null>(null),[error,setError]=useState(false);
 useEffect(()=>{let active=true;setValue(null);setError(false);if(!api.usage||!['session','task','task_attempt'].includes(work.kind))return;void api.usage(work.id).then(result=>{if(active){setValue(result);setError(false);}},()=>{if(active){setValue(null);setError(true);}});return()=>{active=false;};},[api,work]);
 const number=(n:number)=>n.toLocaleString(language);const partial=(complete:boolean)=><>{!complete&&<span className="ec-usage-partial">{t('Partial')}</span>}</>;
 return <section className="ec-inspectsection ec-usage" aria-label={t('Canonical Work usage')}><div className="ec-inspecttitle">{t('Usage')}</div><dl>
 <div className="ec-kv"><dt>{t('Tokens')}</dt><dd>{value?.reportedTokens==null?t('Unavailable'):number(value.reportedTokens)}{value?.reportedTokens!=null&&partial(value.usageComplete)}</dd></div>
 <div className="ec-kv"><dt>{t('Cost')}</dt><dd>{value?.cost?<details className="ec-cost-exact"><summary title={String(value.cost.amount)+' '+value.cost.currency}>{compactCost(value.cost.amount,language,value.cost.currency)}{partial(value.pricingComplete)}</summary><span>{t('Exact estimate')}: <bdi>{value.cost.amount} {value.cost.currency}</bdi></span></details>:t('Unavailable')}</dd></div>
 <div className="ec-kv"><dt>{t('Provider calls')}</dt><dd>{value?number(value.providerCalls):t('Unavailable')}</dd></div>
 {context&&value?.context&&<div className="ec-kv"><dt>{t('Context')}</dt><dd><bdi>{compactNumber(value.context.usedTokens,language)} / {compactNumber(value.context.totalTokens,language)}</bdi></dd><dd>{t('{percent} used',{percent:contextPercent(value.context.usedTokens,value.context.totalTokens,language)})}</dd><dd><meter min={0} max={value.context.totalTokens} value={Math.min(value.context.usedTokens,value.context.totalTokens)} aria-label={t('Context')} title={number(value.context.usedTokens)+' / '+number(value.context.totalTokens)}/></dd><dd><details className="ec-context-detail"><summary>{t('Measurement details')}</summary><p>{t('Latest recorded context measurement; it may change on the next request.')}</p><bdi>{number(value.context.usedTokens)} / {number(value.context.totalTokens)}</bdi><br/><bdi>{value.context.provider} / {value.context.model}</bdi></details></dd></div>}
 </dl><p className="ec-footnote">{error?t('Usage could not be refreshed.'):value?.provisional?t('Latest settled calls; active Work can add usage.'):t('Reported usage from settled provider calls.')}{value?.truncated?' '+t('Inspection limit reached; totals shown are lower bounds.'):''}{!context&&' '+t('Usage totals cover this entire chat or Task.')}</p></section>;
}
