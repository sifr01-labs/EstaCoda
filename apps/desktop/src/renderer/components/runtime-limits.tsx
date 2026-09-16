import {useState} from 'react';
import type {SettingValue} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {Button} from './primitives.js';
const fields=[['cpu','CPU cores',1,.001,64],['memoryBytes','Memory (MB)',1024*1024,6,65536],['timeoutMs','Command timeout (seconds)',1000,.001,86400],['pids','Maximum processes',1,1,65536],['outputBytes','Captured output (MB)',1024*1024,1,16]] as const;
export function RuntimeLimits({value,change,disabled,done}:{value:(id:string)=>SettingValue;change:(id:string,v:SettingValue)=>void;disabled:boolean;done:()=>void}){
 const {t}=useI18n(),[draft,setDraft]=useState(()=>Object.fromEntries(fields.map(([key,,unit])=>[key,String(Number(value('execution.limits.value.'+key))/unit)])));
 const valid=fields.every(([key,,unit,min,max])=>{const n=Number(draft[key]);return draft[key]?.trim()&&Number.isFinite(n)&&n>=min&&n<=max&&(key==='cpu'?Number.isInteger(n*1000):Number.isSafeInteger(n*unit));});
 return <><p className="ec-pageintro">{t('Keep command execution within predictable bounds.')}</p><div className="ec-runtime-limits">{fields.map(([key,label,,min,max])=><label className="ec-field" key={key}>{t(label)}<input type="number" min={min} max={max} step={key==='cpu'||key==='timeoutMs'?.001:1} value={draft[key]} disabled={disabled} onChange={e=>setDraft(old=>({...old,[key]:e.target.value}))}/></label>)}</div>{!valid&&<p role="alert">{t('Enter values within the supported limits.')}</p>}<div className="ec-media-row"><div>{t('Enforcement')}<small>{t('Work cannot start unless these limits can be enforced.')}</small></div><span className="ec-runtime-value">{t('Required')}</span></div><div className="ec-model-footeractions"><Button disabled={disabled||!valid} onClick={()=>{fields.forEach(([key,,unit])=>change('execution.limits.value.'+key,Number(draft[key])*unit));change('execution.limits.requirement','mandatory');done();}}>{t('Done')}</Button></div></>;
}
