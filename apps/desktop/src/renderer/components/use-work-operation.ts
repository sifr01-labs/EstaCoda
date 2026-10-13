import {useEffect,useRef,useState} from 'react';
import type {OperationReceipt,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi,DesktopWorkApi,WorkAction} from '../../shared/desktop-api.js';

const lookupError='Could not refresh request status. The recorded work outcome is unchanged.';
const actionError='The action is not confirmed. Check its result before another request.';
const pending=(receipt:OperationReceipt|null)=>receipt&&['accepted','dispatched'].includes(receipt.state);
/** Retry observations only. A lost mutation response is reconciled, never replayed. */
export function useWorkOperation(api:DesktopWorkApi,work:WorkProjection,observe?:DesktopApi['onSnapshot']){
 const [state,setState]=useState<{busy:boolean;receipt:OperationReceipt|null;error:string}>({busy:true,receipt:null,error:''});
 const lastStatus=useRef(work.status);
 const controls=useRef({refresh:()=>{},act:(_action:WorkAction['action'],_stepId?:string)=>{}});
 useEffect(()=>{
  let observed=false,disposed=false,ready=!observe,revision=0,failures=0,mutating=false,refreshAfterAction=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const clear=()=>{clearTimeout(timer);timer=undefined;};
  const current=(version:number)=>!disposed&&ready&&revision===version;
  const later=(delay:number)=>{clear();timer=setTimeout(()=>void inspect(),delay);};
  const inspect=async()=>{
   clear();if(disposed||!ready)return;
   if(mutating){refreshAfterAction=true;return;}
   const version=++revision;setState(old=>({...old,busy:true}));
   try{
    const receipt=await api.inspect(work.id);if(!current(version))return;
    failures=0;setState({busy:false,receipt,error:''});if(pending(receipt))later(1500);
   }catch{
    if(!current(version))return;
    setState(old=>({...old,busy:false,error:lookupError}));
    if(++failures<=3)later(1500*2**(failures-1));
   }
  };
  const refresh=()=>{failures=0;void inspect();};
  const act=async(action:WorkAction['action'],stepId?:string)=>{
   if(disposed||!ready||mutating)return;
   clear();mutating=true;const version=++revision;setState(old=>({...old,busy:true,error:''}));
   try{
    const receipt=await api.act({workId:work.id,action,...(stepId?{stepId}:{})});
    if(current(version)){setState({busy:false,receipt,error:''});if(pending(receipt))later(1500);}
   }catch{
    if(current(version)){setState(old=>({...old,busy:false,error:actionError}));failures=0;later(1500);}
   }finally{
    mutating=false;if(!disposed&&refreshAfterAction){refreshAfterAction=false;refresh();}
   }
  };
  controls.current={refresh,act:(action,stepId)=>{void act(action,stepId);}};
  setState({busy:true,receipt:null,error:''});
  // Readiness transitions trigger reconciliation; ordinary snapshots do not poll.
  const unsubscribe=observe?.(snapshot=>{
   const next=snapshot.status==='ready'&&snapshot.profile.id===work.profileId;
   if(observed&&next===ready)return;observed=true;ready=next;revision++;clear();
   if(ready)refresh();else setState(old=>({...old,busy:false,error:mutating?actionError:lookupError}));
  });
  if(!observe)refresh();
  const focus=()=>refresh();window.addEventListener('focus',focus);window.addEventListener('online',focus);
  return()=>{disposed=true;revision++;clear();unsubscribe?.();window.removeEventListener('focus',focus);window.removeEventListener('online',focus);};
 },[api,work.id,work.profileId,observe]);
 // A new turn or a settled outcome may supersede a previously completed receipt.
 useEffect(()=>{if(lastStatus.current!==work.status){lastStatus.current=work.status;controls.current.refresh();}},[work.status]);
 return {...state,inspect:()=>controls.current.refresh(),act:(action:WorkAction['action'],stepId?:string)=>controls.current.act(action,stepId),lookupFailed:state.error===lookupError};
}
