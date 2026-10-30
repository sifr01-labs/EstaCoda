import {useState} from 'react';
import type {SettingValue} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {Button} from './primitives.js';

const fields=[['maxDurationMinutes','Run duration (minutes)',10080],['maxIterations','Model steps',1000000],['maxToolCalls','Tool calls',1000000]] as const;
const scopes=['interactive','unattended'] as const;
export function RuntimeRunLimits({value,change,disabled,done}:{value:(id:string)=>SettingValue;change:(id:string,v:SettingValue)=>void;disabled:boolean;done:()=>void}){
 const {t}=useI18n();
 const [draft,setDraft]=useState(()=>Object.fromEntries(scopes.flatMap(scope=>fields.map(([key])=>[`${scope}.${key}`,String(value(`runLimits.${scope}.${key}`)??'')]))));
 const valid=scopes.every(scope=>fields.every(([key,,max])=>{const raw=draft[`${scope}.${key}`],n=Number(raw);return raw?.trim()&&Number.isSafeInteger(n)&&n>=(scope==='interactive'?0:1)&&n<=max;}));
 const unlimited=fields.every(([key])=>draft[`interactive.${key}`]==='0');
 return <><p className="ec-pageintro">{t('Choose how long the agent may keep working. Saved changes apply to new runs.')}</p>
 {scopes.map(scope=><section className="ec-media-section" key={scope}><h3>{t(scope==='interactive'?'Interactive work':'Unattended work')}</h3><p className="ec-media-description">{t(scope==='interactive'?'Work in the CLI or desktop. Zero means no limit for that setting.':'Background, channel, and delegated work always uses finite limits.')}</p>
 {scope==='interactive'&&<div className="ec-media-row"><div>{t('Until complete')}<small>{t('Continue while making progress. You can stop at any time.')}</small></div><input className="ec-media-switch" type="checkbox" role="switch" aria-label={t('Until complete')} checked={unlimited} disabled={disabled} onChange={e=>setDraft(old=>({...old,...Object.fromEntries(fields.map(([key])=>[`interactive.${key}`,e.target.checked?'0':key==='maxDurationMinutes'?'30':key==='maxIterations'?'45':'100']))}))}/></div>}
 <div className="ec-runtime-limits">{fields.map(([key,label,max])=><label className="ec-field" key={key}>{t(label)}<input type="number" min={scope==='interactive'?0:1} max={max} step={1} value={draft[`${scope}.${key}`]} disabled={disabled} onChange={e=>setDraft(old=>({...old,[`${scope}.${key}`]:e.target.value}))}/></label>)}</div></section>)}
 {!valid&&<p role="alert">{t('Enter values within the supported limits.')}</p>}<p className="ec-footnote">{t('Action approvals, request timeouts, and repeated-failure protection still apply.')}</p>
 <div className="ec-model-footeractions"><Button disabled={disabled||!valid} onClick={()=>{for(const scope of scopes)for(const [key] of fields)change(`runLimits.${scope}.${key}`,Number(draft[`${scope}.${key}`]));done();}}>{t('Done')}</Button></div></>;
}
