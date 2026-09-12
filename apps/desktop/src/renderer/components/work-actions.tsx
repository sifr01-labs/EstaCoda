import {useEffect,useRef,useState} from 'react';
import type {OperationReceipt,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopWorkApi,WorkAction} from '../../shared/desktop-api.js';
import {Button} from './primitives.js';
const labels:Partial<Record<WorkAction['action'],string>>={'sessions.resume':'Resume Session','sessions.cancelTurn':'Stop','tasks.pause':'Pause Task','tasks.resume':'Resume Task','tasks.cancel':'Cancel Task','tasks.retry':'Retry step'};
export function WorkActions({api,work}:{api:DesktopWorkApi;work:WorkProjection}){
 const[busy,setBusy]=useState(false),[receipt,setReceipt]=useState<OperationReceipt|null>(null),[error,setError]=useState('');const alive=useRef(true);
 const inspect=async()=>{setBusy(true);try{const next=await api.inspect(work.id);if(alive.current){setReceipt(next);setError('');}}catch{if(alive.current)setError('Operation status unavailable. Check again after reconnecting.');}finally{if(alive.current)setBusy(false);}};
 useEffect(()=>{alive.current=true;void inspect();return()=>{alive.current=false;};},[api,work.id]);
 useEffect(()=>{if(!receipt||!['accepted','dispatched'].includes(receipt.state))return;const timer=setTimeout(()=>void inspect(),1500);return()=>clearTimeout(timer);},[receipt]);
 const act=async(action:WorkAction['action'],stepId?:string)=>{setBusy(true);setError('');try{const next=await api.act({workId:work.id,action,...(stepId?{stepId}:{})});if(alive.current)setReceipt(next);}catch{if(alive.current)setError('The action is not confirmed. Check its result before another request.');}finally{if(alive.current)setBusy(false);}};
 return <section aria-label="Work controls"><div className="ec-actions">{work.actions?.filter(action=>action.id in labels).map(action=><Button key={action.id+':'+action.stepId} disabled={busy||!action.enabled} title={action.reason} onClick={()=>void act(action.id as WorkAction['action'],action.stepId)}>{labels[action.id as WorkAction['action']]}{action.stepId?' · '+action.stepId:''}</Button>)}<Button disabled={busy} onClick={()=>void inspect()}>Check operation</Button></div>{receipt&&<p role="status" className="ec-footnote">{receipt.cancellation==='requested'?'Cancellation requested. Waiting for canonical termination.':receipt.state==='completed'?'Control operation settled. Work outcome is shown separately.':['accepted','dispatched'].includes(receipt.state)?'Request accepted; waiting for the execution owner.':'Operation '+receipt.state+'. Inspect Work before deciding on a new request.'}</p>}{error&&<p role="alert">{error}</p>}</section>;
}
