import {statusLabel} from './sidebar.js';
import {WorkPopover} from './work-popover.js';
import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {useI18n} from '../i18n.js';
import {useEffect,useState} from 'react';
import type {OperationReceipt,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi,DesktopWorkApi,WorkAction} from '../../shared/desktop-api.js';
import {Button} from './primitives.js';
import {useWorkOperation} from './use-work-operation.js';
const labels:Partial<Record<WorkAction['action'],string>>={'sessions.resume':'Resume','sessions.cancelTurn':'Stop','tasks.pause':'Pause Task','tasks.resume':'Resume Task','tasks.cancel':'Cancel Task','tasks.retry':'Retry step'};
export function WorkActions({api,work,inspectDetails=false,compact=false,extra,observe}:{api:DesktopWorkApi;work:WorkProjection;inspectDetails?:boolean;compact?:boolean;extra?:ReactNode;observe?:DesktopApi['onSnapshot']}){
 const {t,owned,status}=useI18n();
 const[attentionHost,setAttentionHost]=useState<HTMLElement|null>(null);useEffect(()=>{setAttentionHost(compact?document.getElementById('ec-work-attention'):null);},[compact,work.id]);
 const[detailHost,setDetailHost]=useState<HTMLElement|null>(null);useEffect(()=>{setDetailHost(inspectDetails?document.getElementById('ec-operation-details'):null);},[inspectDetails]);
 const {busy,receipt,error,inspect,act,lookupFailed}=useWorkOperation(api,work,observe);
 const actions=work.actions?.filter(action=>action.id in labels&&(!compact||action.id!=='sessions.cancelTurn')&&(action.enabled||!['completed','partial','failed','cancelled'].includes(work.status)))??[];
 const actionButton=(action:typeof actions[number])=><Button key={action.id+':'+action.stepId} disabled={busy||!action.enabled} title={action.reason?t("Action unavailable. Refresh and inspect the current Work state."):undefined} onClick={()=>void act(action.id as WorkAction['action'],action.stepId)}>{owned(labels[action.id as WorkAction['action']]!)}{action.stepId?' · '+action.stepId:''}</Button>;
 const notice=!error&&receipt&&(receipt.state!=='completed'||receipt.cancellation==='requested'&&!['completed','partial','failed','cancelled'].includes(work.status))?(receipt.cancellation==='requested'?owned(cancellationNotice(work.status)):['accepted','dispatched'].includes(receipt.state)?t("Request accepted; waiting for the execution owner."):t("Operation")+" "+status(receipt.state)+t(". Inspect Work before deciding on a new request.")):'';
 const recovery=!!error||!!receipt&&['uncertain','unknown','expired'].includes(receipt.state);
 const check=<Button disabled={busy} onClick={()=>void inspect()}>{t("Check execution status")}</Button>;
 const operation=<>{notice&&<p role="status" className="ec-footnote">{notice}</p>}{error&&<p role="alert">{owned(error)}</p>}</>;
 const urgent=!!error||!!receipt&&!['completed','accepted','dispatched'].includes(receipt.state);
 const attention=(notice||error)&&<WorkPopover label={lookupFailed?t("Request status unavailable"):urgent?t("Needs attention"):t("Request pending")} icon={urgent?'circle-alert':'clock-3'} warning={urgent}>{operation}{check}</WorkPopover>;
 const immediate=(action:typeof actions[number])=>action.enabled&&['sessions.cancelTurn','tasks.pause','tasks.cancel'].includes(action.id);
 return <section className="ec-workcontrols" aria-label={t("Work controls")}>{compact?<><div className="ec-actions">{actions.filter(immediate).map(actionButton)}</div><WorkPopover label={t("More actions")} icon="ellipsis" iconOnly>{extra}{actions.filter(action=>!immediate(action)).map(actionButton)}{recovery&&check}</WorkPopover>{attentionHost&&createPortal(<div aria-live="polite">{attention}</div>,attentionHost)}</>:<><div className="ec-actions">{actions.map(actionButton)}{recovery&&check}</div>{operation}</>}{detailHost&&createPortal(<><div className="ec-inspecttitle">{t("Current status")}<Button className="ec-ghost ec-iconbutton" icon="refresh-cw" aria-label={t("Check execution status")} title={t("Check execution status")} disabled={busy} onClick={()=>void inspect()}/></div><p className="ec-current-state" role="status">{owned(statusLabel(work))}</p><div className="ec-request-detail"><h3>{t("Latest request")}</h3>{receipt?<><p>{owned(requestLabel(receipt))}</p><small>{owned(requestOutcome(receipt,work.status))}</small></>:<p className="ec-footnote">{t(busy?'Checking…':'No recent request recorded.')}</p>}{error&&<p role="alert">{owned(error)}</p>}</div></>,detailHost)}</section>;
}

export function cancellationNotice(status:WorkProjection['status']):string {
 if(status==='cancelled')return 'Execution cancelled.';
 if(['completed','partial','failed'].includes(status))return 'Execution ended. Its final outcome is shown separately.';
 return 'Stopping…';
}

/** A control request completing does not mean the agent's work has completed. */
export function requestLabel(receipt:OperationReceipt):string {
 if(receipt.method==='sessions.cancelTurn'||receipt.method==='tasks.cancel'||receipt.cancellation==='requested'||receipt.cancellation==='confirmed')return 'Stop request';
 return ({'sessions.send':'Message','sessions.start':'Start request','sessions.resume':'Resume request','tasks.create':'Create Task','tasks.pause':'Pause request','tasks.resume':'Resume request','tasks.retry':'Retry request','tasks.guide':'Guidance','sessions.setModel':'Model change','tasks.setModel':'Model change','approvals.resolve':'Approval decision'} as Partial<Record<OperationReceipt['method'],string>>)[receipt.method]??'Control request';
}
export function requestOutcome(receipt:OperationReceipt,workStatus?:WorkProjection['status']):string {
 if(receipt.cancellation==='confirmed')return 'Stop confirmed';
 if(['uncertain','unknown','expired'].includes(receipt.state))return 'Result not confirmed';
 if(receipt.cancellation==='requested'&&workStatus&&['completed','partial','failed','cancelled'].includes(workStatus))return 'Request received · work has ended';
 if(receipt.cancellation==='requested')return 'Stop requested · awaiting confirmation';
 if(receipt.state==='completed')return 'Request completed';
 if(receipt.state==='accepted'||receipt.state==='dispatched')return 'Request received · awaiting result';
 return 'Result not confirmed';
}
