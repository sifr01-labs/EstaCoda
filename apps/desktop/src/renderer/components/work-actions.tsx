import {WorkPopover} from './work-popover.js';
import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {useI18n} from '../i18n.js';
import {useEffect,useRef,useState} from 'react';
import type {OperationReceipt,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopWorkApi,WorkAction} from '../../shared/desktop-api.js';
import {Button} from './primitives.js';
const labels:Partial<Record<WorkAction['action'],string>>={'sessions.resume':'Resume','sessions.cancelTurn':'Stop','tasks.pause':'Pause Task','tasks.resume':'Resume Task','tasks.cancel':'Cancel Task','tasks.retry':'Retry step'};
export function WorkActions({api,work,inspectDetails=false,compact=false,extra}:{api:DesktopWorkApi;work:WorkProjection;inspectDetails?:boolean;compact?:boolean;extra?:ReactNode}){
 const {t,owned,status}=useI18n();
 const[attentionHost,setAttentionHost]=useState<HTMLElement|null>(null);useEffect(()=>{setAttentionHost(compact?document.getElementById('ec-work-attention'):null);},[compact,work.id]);
 const[detailHost,setDetailHost]=useState<HTMLElement|null>(null);useEffect(()=>{setDetailHost(inspectDetails?document.getElementById('ec-operation-details'):null);},[inspectDetails]);
 const[busy,setBusy]=useState(false),[receipt,setReceipt]=useState<OperationReceipt|null>(null),[error,setError]=useState('');const alive=useRef(true);
 const inspect=async()=>{setBusy(true);try{const next=await api.inspect(work.id);if(alive.current){setReceipt(next);setError('');}}catch{if(alive.current)setError('Operation status unavailable. Check again after reconnecting.');}finally{if(alive.current)setBusy(false);}};
 useEffect(()=>{alive.current=true;void inspect();return()=>{alive.current=false;};},[api,work.id]);
 useEffect(()=>{if(!receipt||!['accepted','dispatched'].includes(receipt.state))return;const timer=setTimeout(()=>void inspect(),1500);return()=>clearTimeout(timer);},[receipt]);
 const act=async(action:WorkAction['action'],stepId?:string)=>{setBusy(true);setError('');try{const next=await api.act({workId:work.id,action,...(stepId?{stepId}:{})});if(alive.current)setReceipt(next);}catch{if(alive.current)setError('The action is not confirmed. Check its result before another request.');}finally{if(alive.current)setBusy(false);}};
 const actions=work.actions?.filter(action=>action.id in labels&&(action.enabled||!['completed','partial','failed','cancelled'].includes(work.status)))??[];
 const actionButton=(action:typeof actions[number])=><Button key={action.id+':'+action.stepId} disabled={busy||!action.enabled} title={action.reason?t("Action unavailable. Refresh and inspect the current Work state."):undefined} onClick={()=>void act(action.id as WorkAction['action'],action.stepId)}>{owned(labels[action.id as WorkAction['action']]!)}{action.stepId?' · '+action.stepId:''}</Button>;
 const notice=receipt&&(receipt.state!=='completed'||receipt.cancellation==='requested'&&!['completed','partial','failed','cancelled'].includes(work.status))?(receipt.cancellation==='requested'?owned(cancellationNotice(work.status)):['accepted','dispatched'].includes(receipt.state)?t("Request accepted; waiting for the execution owner."):t("Operation")+" "+status(receipt.state)+t(". Inspect Work before deciding on a new request.")):'';
 const recovery=!!error||!!receipt&&['uncertain','unknown','expired'].includes(receipt.state);
 const check=<Button disabled={busy} onClick={()=>void inspect()}>{t("Check operation")}</Button>;
 const operation=<>{notice&&<p role="status" className="ec-footnote">{notice}</p>}{error&&<p role="alert">{owned(error)}</p>}</>;
 const urgent=!!error||!!receipt&&!['completed','accepted','dispatched'].includes(receipt.state);
 const attention=(notice||error)&&<WorkPopover label={error==='Operation status unavailable. Check again after reconnecting.'?t("Check connection"):urgent?t("Needs attention"):t("Request pending")} icon={urgent?'circle-alert':'clock-3'} warning={urgent}>{operation}{check}</WorkPopover>;
 const immediate=(action:typeof actions[number])=>action.enabled&&['sessions.cancelTurn','tasks.pause','tasks.cancel'].includes(action.id);
 return <section className="ec-workcontrols" aria-label={t("Work controls")}>{compact?<><div className="ec-actions">{actions.filter(immediate).map(actionButton)}</div><WorkPopover label={t("More actions")} icon="ellipsis" iconOnly>{extra}{actions.filter(action=>!immediate(action)).map(actionButton)}{recovery&&check}</WorkPopover>{attentionHost&&createPortal(<div aria-live="polite">{attention}</div>,attentionHost)}</>:<><div className="ec-actions">{actions.map(actionButton)}{recovery&&check}</div>{operation}</>}{detailHost&&(notice||error)&&createPortal(<><h3>{t("Execution status")}</h3>{check}{receipt&&<p>{status(receipt.state)}</p>}{operation}</>,detailHost)}</section>;
}

export function cancellationNotice(status:WorkProjection['status']):string {
 if(status==='cancelled')return 'Execution cancelled.';
 if(['completed','partial','failed'].includes(status))return 'Execution ended. Its final outcome is shown separately.';
 return 'Cancellation requested. Waiting for canonical termination.';
}
