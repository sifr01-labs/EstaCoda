import {useEffect,useRef,useState} from 'react';
import type {ScheduleProjection,ScheduleReview} from '@estacoda/control-protocol';
import type {DesktopSchedulesApi} from '../../shared/desktop-api.js';
import {Button} from './primitives.js';
export function ScheduleActions({api,job,onChanged}:{api:DesktopSchedulesApi;job:ScheduleProjection;onChanged:()=>void}){
 const label=(s:string)=>s;
 const[review,setReview]=useState<ScheduleReview>(),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[message,setMessage]=useState('');const current=useRef<ScheduleReview|undefined>(undefined),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(current.current)void api.cancel(current.current.reviewId).catch(()=>{});};},[api]);
 const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setMessage('');try{await fn();}catch{if(alive.current)setMessage('Schedule action unavailable. Refresh and review again.');}finally{if(alive.current)setBusy(false);}};
 const prepare=(action:'enable'|'disable'|'run-now')=>void run(async()=>{const r=await api.review({action,id:job.id});if(!alive.current){await api.cancel(r.reviewId);return;}current.current=r;setReview(r);});
 return <div aria-label={label('Schedule actions')}>
 {!review&&<><Button disabled={busy||uncertain||job.runRequested} onClick={()=>prepare('run-now')}>{label('Run now')}</Button><Button disabled={busy||uncertain} onClick={()=>prepare(job.status==='active'?'disable':'enable')}>{label(job.status==='active'?'Disable schedule':'Enable schedule')}</Button></>}
 {review&&<div><h4>{label('Schedule review')}</h4><p>{label(review.action.action==='run-now'?'Queue one run. A paused recurring schedule stays paused. Completed schedules may become active. The runtime must be available.':review.action.action==='disable'?'Disable future runs and clear queued manual requests. An execution already started is not cancelled.':'Enable this schedule. The runtime calculates its next run.')}</p>
 <dl>{[[label('Profile'),review.profileId],[label('Workspace'),review.workspace??'—'],[label('Next run (UTC)'),review.nextRunAt??'—'],[label('Model'),review.model],[label('Authority'),review.authority],[label('Estimated USD limit per run'),review.spendUsd===null?label('No profile session spending ceiling'):String(review.spendUsd)]].map(([key,value])=><div key={key}><dt>{key}</dt><dd><bdi>{value}</bdi></dd></div>)}</dl>
 {review.definition&&<><p dir="auto">{review.definition.objective}</p><p><bdi>{review.definition.delivery}</bdi></p>{review.definition.script&&<pre dir="ltr">{[review.definition.script,...review.definition.scriptArgs].join('\n')}</pre>}</>}
 <p>{label('Model, authority and spending defaults are revalidated at execution. Failures are recorded; recurring schedules continue at their next run without an automatic retry.')}</p>
 <Button disabled={busy||uncertain} onClick={()=>void run(async()=>{setUncertain(true);const r=await api.execute(review.reviewId,true);if(!alive.current)return;current.current=undefined;if(r.state==='completed'){onChanged();}else if(r.state==='failed'){setUncertain(false);setReview(undefined);setMessage('Schedule changed or was rejected. Review again.');}else setMessage('Outcome uncertain. Inspect the last schedule operation before retrying.');})}>{label('Confirm schedule change')}</Button>
 <Button disabled={busy||uncertain} onClick={()=>void run(async()=>{await api.cancel(review.reviewId);current.current=undefined;setReview(undefined);})}>{label('Cancel')}</Button></div>}
 {message&&<p role="alert">{label(message)}</p>}
 {uncertain&&<Button disabled={busy} onClick={()=>void run(async()=>{const r=await api.inspect();if(r?.state==='completed')onChanged();else if(r?.state==='failed'){setUncertain(false);setReview(undefined);setMessage('Schedule changed or was rejected. Review again.');}else setMessage('Outcome uncertain. Inspect the last schedule operation before retrying.');})}>{label('Inspect last schedule operation')}</Button>}
 </div>;
}
