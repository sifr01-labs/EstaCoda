import {createPortal} from 'react-dom';
import {useI18n} from '../i18n.js';
import {useEffect,useRef,useState} from 'react';
import type {OperationReceipt,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopWorkApi,WorkAction} from '../../shared/desktop-api.js';
import {Button} from './primitives.js';
const labels:Partial<Record<WorkAction['action'],string>>={'sessions.resume':'Resume','sessions.cancelTurn':'Stop','tasks.pause':'Pause Task','tasks.resume':'Resume Task','tasks.cancel':'Cancel Task','tasks.retry':'Retry step'};
export function WorkActions({api,work,inspectDetails=false}:{api:DesktopWorkApi;work:WorkProjection;inspectDetails?:boolean}){
 const {t,owned,status}=useI18n();
 const[detailHost,setDetailHost]=useState<HTMLElement|null>(null);useEffect(()=>{setDetailHost(inspectDetails?document.getElementById('ec-operation-details'):null);},[inspectDetails]);
 const[busy,setBusy]=useState(false),[receipt,setReceipt]=useState<OperationReceipt|null>(null),[error,setError]=useState('');const alive=useRef(true);
 const inspect=async()=>{setBusy(true);try{const next=await api.inspect(work.id);if(alive.current){setReceipt(next);setError('');}}catch{if(alive.current)setError('Operation status unavailable. Check again after reconnecting.');}finally{if(alive.current)setBusy(false);}};
 useEffect(()=>{alive.current=true;void inspect();return()=>{alive.current=false;};},[api,work.id]);
 useEffect(()=>{if(!receipt||!['accepted','dispatched'].includes(receipt.state))return;const timer=setTimeout(()=>void inspect(),1500);return()=>clearTimeout(timer);},[receipt]);
 const act=async(action:WorkAction['action'],stepId?:string)=>{setBusy(true);setError('');try{const next=await api.act({workId:work.id,action,...(stepId?{stepId}:{})});if(alive.current)setReceipt(next);}catch{if(alive.current)setError('The action is not confirmed. Check its result before another request.');}finally{if(alive.current)setBusy(false);}};
 return <section className="ec-workcontrols" aria-label={t("Work controls")}><div className="ec-actions">{work.actions?.filter(action=>action.id in labels&&(action.enabled||!['completed','partial','failed','cancelled'].includes(work.status))).map(action=><Button key={action.id+':'+action.stepId} disabled={busy||!action.enabled} title={action.reason?t("Action unavailable. Refresh and inspect the current Work state."):undefined} onClick={()=>void act(action.id as WorkAction['action'],action.stepId)}>{owned(labels[action.id as WorkAction['action']]!)}{action.stepId?' · '+action.stepId:''}</Button>)}<>{(error||receipt&&['uncertain','unknown','expired'].includes(receipt.state))&&<Button disabled={busy} onClick={()=>void inspect()}>{t("Check operation")}</Button>}</></div>{receipt&&(receipt.state!=='completed'||receipt.cancellation==='requested'&&!['completed','partial','failed','cancelled'].includes(work.status))&&<p role="status" className="ec-footnote">{receipt.cancellation==='requested'?owned(cancellationNotice(work.status)):receipt.state==='completed'?t("Control operation settled. Work outcome is shown separately."):['accepted','dispatched'].includes(receipt.state)?t("Request accepted; waiting for the execution owner."):t("Operation")+" "+status(receipt.state)+t(". Inspect Work before deciding on a new request.")}</p>}{error&&<p role="alert">{owned(error)}</p>}{detailHost&&createPortal(<><h3>{t("Operation")}</h3><Button disabled={busy} onClick={()=>void inspect()}>{t("Check operation")}</Button>{receipt&&<p>{status(receipt.state)}</p>}</>,detailHost)}</section>;
}

export function cancellationNotice(status:WorkProjection['status']):string {
 if(status==='cancelled')return 'Execution cancelled.';
 if(['completed','partial','failed'].includes(status))return 'Execution ended. Its final outcome is shown separately.';
 return 'Cancellation requested. Waiting for canonical termination.';
}
