import {useI18n} from '../i18n.js';
import {useEffect,useRef,useState} from 'react';
import {humanBrowserKey,type BrowserViewReference,type HumanBrowserFrame,type HumanBrowserInput,type BrowserWorkspaceState,type BrowserWorkspaceAction} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {Button,Badge,Icon} from './primitives.js';
export function BrowserTakeover({api,workId,reference,active}:{api:NonNullable<DesktopApi['browserControl']>;workId:string;reference?:BrowserViewReference;active:(value:boolean)=>void}){
 const {t,owned,status}=useI18n();
 const[submitRef,setSubmitRef]=useState(''),[secretKind,setSecretKind]=useState<'password'|'one-time-code'>('password');
 const[workspace,setWorkspace]=useState<BrowserWorkspaceState>(),[address,setAddress]=useState('');
 const[id,setId]=useState<string>(),[frame,setFrame]=useState<HumanBrowserFrame>(),[busy,setBusy]=useState(false),[error,setError]=useState('');const queuedKeys=useRef<Array<{key:string;context:string}>>([]),inputRunning=useRef(false);
 const handle=useRef<string|undefined>(undefined),epoch=useRef(0);
 useEffect(()=>{let live=true;const revision=epoch.current;if(api.inventory)void api.inventory(workId).then(value=>{if(live&&revision===epoch.current)setWorkspace(value);}).catch(()=>{if(live&&revision===epoch.current)setError('Browser inventory is busy or unavailable. Try Take control again once browser work settles; an abandoned lease may need up to ten seconds to expire.');});return()=>{live=false;};},[api,workId]);
 useEffect(()=>()=>{epoch.current++;queuedKeys.current=[];if(handle.current)void api.abandon(handle.current).catch(()=>{});active(false);},[api,active]);
 const failure=()=>{queuedKeys.current=[];if(handle.current)void api.abandon(handle.current).catch(()=>{});handle.current=undefined;setId(undefined);setFrame(undefined);active(false);setError('Control unavailable or uncertain. Browser execution remains paused if takeover began. Reacquire control to inspect or explicitly return it to the agent.');};
 const open=async()=>{const revision=++epoch.current;setBusy(true);setError('');try{const value=await (reference?api.open(workId,reference):api.openWorkspace!(workId));if(revision!==epoch.current){void api.abandon(value.id);return;}handle.current=value.id;setId(value.id);active(true);if(api.workspace){const state=await api.workspace(value.id,{kind:'list'});if(revision===epoch.current)setWorkspace(state);}}catch{if(revision===epoch.current)failure();}finally{if(revision===epoch.current)setBusy(false);}};
 const refresh=async(input?:HumanBrowserInput)=>{
  if(!id)return;
  if(inputRunning.current&&input?.kind==='key'){
   if(!frame?.inputContextId||queuedKeys.current.length>=64){setError('Typing queue is full or the field cannot be verified. Wait for the browser, then re-enter the remaining text.');return;}
   queuedKeys.current.push({key:input.key,context:frame.inputContextId});return;
  }
  if(busy||inputRunning.current){if(input)setError('Browser is busy. This input was not sent; wait and try again.');return;}
  const revision=++epoch.current;inputRunning.current=true;setBusy(true);setError('');
  try{
   let next=input;
   while(true){
    const value=await api.frame(id,next);if(revision!==epoch.current)return;
    setFrame(value);setSubmitRef('');setAddress(value.url);
    const queued=queuedKeys.current.shift();if(!queued)break;
    if(value.protectedFieldFocused||!value.inputContextId||queued.context!==value.inputContextId){queuedKeys.current=[];setError('The page or focused field changed. Remaining queued text was not sent; inspect the browser before typing again.');break;}
    next={kind:'key',frameId:value.frameId,key:queued.key};
   }
  }catch{if(revision===epoch.current)failure();}
  finally{queuedKeys.current=[];inputRunning.current=false;if(revision===epoch.current)setBusy(false);}
 };
 const release=async()=>{if(!id||busy)return;const revision=++epoch.current;setBusy(true);try{await api.release(id);if(revision===epoch.current){handle.current=undefined;setId(undefined);setFrame(undefined);active(false);setError('Control returned to the agent.');}}catch{if(revision===epoch.current)failure();}finally{if(revision===epoch.current)setBusy(false);}};
 const operate=async(operation:BrowserWorkspaceAction)=>{if(!id||busy||!api.workspace)return;const revision=++epoch.current;setBusy(true);setFrame(undefined);setError('');try{const state=await api.workspace(id,operation);if(revision===epoch.current){setWorkspace(state);setAddress(state.sessions.find(s=>s.id===state.selectedSessionId)?.tabs.find(t=>t.controlled)?.url??'');}}catch{if(revision===epoch.current)failure();}finally{if(revision===epoch.current)setBusy(false);}};
 const signIn=async()=>{if(!id||!frame||busy||!submitRef||!api.signIn)return;const revision=++epoch.current;setBusy(true);setError('');try{const result=await api.signIn(id,frame.frameId,submitRef,secretKind);if(revision===epoch.current){setFrame(undefined);setError(result.submitted?'Entry submitted. Refresh the live view to check the result.':'Protected entry cancelled. Refresh the live view to continue.');}}catch{if(revision===epoch.current)failure();}finally{if(revision===epoch.current)setBusy(false);}};
 const session=workspace?.sessions.find(s=>s.id===workspace.selectedSessionId);
 return <section className="ec-browsercontrol" aria-label={t("Browser control")}>
  <Badge>{id?t("You control this browser"):t("Human takeover")}</Badge>
  <p className="ec-footnote">{t("Agent browser actions pause during takeover. Closing this view keeps them paused; use Return to agent when finished.")}</p>
  {!id?<Button disabled={busy||workspace?.supported===false} onClick={()=>void open()}>{t("Take control")}</Button>:<><Button disabled={busy} onClick={()=>void refresh()}>{t("Refresh live view")}</Button><Button disabled={busy} onClick={()=>void release()}>{t("Return to agent")}</Button></>}
  {workspace?.reason&&<p className="ec-footnote">{workspace.supported?t("Live viewing unavailable. Recorded views remain available."):t("This backend supports recorded viewing only.")}</p>}
  {id&&api.workspace&&workspace?.supported&&<div className="ec-browserworkspace">
   <div className="ec-browserbar"><label>{t("Session")+" "}<select aria-label={t("Browser session")} disabled={!id||busy} value={workspace.selectedSessionId??''} onChange={e=>void operate({kind:'select-session',sessionId:e.target.value})}><option value="" disabled>{t("Select session")}</option>{workspace.sessions.map(s=><option key={s.id} value={s.id}>{s.tabs.find(t=>t.controlled)?.title??s.id}</option>)}</select></label><Button disabled={!id||busy||!session} onClick={()=>void operate({kind:'close-session'})}>{t("Close session")}</Button></div>
   <div className="ec-browserbar" role="group" aria-label={t("Browser tabs")}>{session?.tabs.map(tab=><span key={tab.ref}><Button disabled={!id||busy} aria-pressed={tab.controlled} onClick={()=>void operate({kind:'switch-tab',tabRef:tab.ref})}>{tab.title||tab.ref}</Button>{tab.closable&&<Button aria-label={t("Close tab")+" "+tab.title} disabled={!id||busy} onClick={()=>void operate({kind:'close-tab',tabRef:tab.ref})}>×</Button>}</span>)}</div>
   <form className="ec-browserbar" onSubmit={e=>{e.preventDefault();void operate({kind:session?'navigate':'create',url:address});}}>
    <Button type="button" aria-label={t("Back")} disabled={!id||busy||!session} onClick={()=>void operate({kind:'back'})}><Icon name="arrow-left"/></Button><Button type="button" aria-label={t("Forward")} disabled={!id||busy||!session} onClick={()=>void operate({kind:'forward'})}><Icon name="arrow-right"/></Button><Button type="button" disabled={!id||busy||!session} onClick={()=>void operate({kind:'reload'})}>{t("Reload")}</Button>
    <input aria-label={t("Browser address")} dir="ltr" type="url" placeholder="https://" value={address} disabled={!id||busy} onChange={e=>setAddress(e.target.value)}/><Button type="submit" disabled={!id||busy||!address}>{session?t("Go"):t("Open session")}</Button>
    <Button type="button" disabled={!id||busy||!address||!session} onClick={()=>void operate({kind:'new-tab',url:address})}>{t("New tab")}</Button><Button type="button" disabled={!id||busy||!address} onClick={()=>void operate({kind:'create',url:address})}>{t("New session")}</Button>
   </form>{workspace.truncated&&<p className="ec-footnote">{t("Inventory is limited to 8 sessions and 16 tabs.")}</p>}
  </div>}
  {error&&<p role="status">{owned(error)}</p>}{id&&!frame&&!busy&&<p>{t("Refresh the live view to enable pointer and keyboard input.")}</p>}{busy&&<p role="status">{t("Waiting for browser…")}</p>}
  {id&&frame&&<>{api.signIn&&<div className="ec-browserbar"><p className="ec-footnote">{t("For sign-in, click the password or code field, choose its submit button, then enter securely.")}</p><select aria-label={t("Protected entry kind")} value={secretKind} disabled={busy} onChange={e=>setSecretKind(e.target.value as 'password'|'one-time-code')}><option value="password">{t("Password")}</option><option value="one-time-code">{t("One-time code")}</option></select><select aria-label={t("Sign-in submit button")} value={submitRef} disabled={busy} onChange={e=>setSubmitRef(e.target.value)}><option value="">{t("Choose submit button")}</option>{frame.submitTargets?.map(target=><option key={target.ref} value={target.ref}>{target.label}</option>)}</select><Button disabled={busy||!submitRef} onClick={()=>void signIn()}>{t("Enter securely")}</Button></div>}<p className="ec-browserurl"><bdi dir="ltr">{frame.url}</bdi></p><div tabIndex={0} role="group" aria-busy={busy} aria-label={t("Controlled browser viewport")} onKeyDown={event=>{if(frame.protectedFieldFocused||event.key==='Escape'||event.ctrlKey||event.metaKey||event.altKey||event.nativeEvent.isComposing||!humanBrowserKey(event.key))return;event.preventDefault();void refresh({kind:'key',frameId:frame.frameId,key:event.key});}}>
   <img src={'data:image/jpeg;base64,'+frame.image} alt={t("Live sanitized browser viewport")} onClick={event=>{event.currentTarget.parentElement?.focus();const rect=event.currentTarget.getBoundingClientRect();const x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;if(x>=0&&x<1&&y>=0&&y<1)void refresh({kind:'pointer',frameId:frame.frameId,x,y});}}/>
  </div><p className="ec-footnote">{status(frame.readiness??"unknown")} {" "+t("· Observed")+" "}<bdi dir="ltr">{frame.observedAt}</bdi>. {frame.protectedFieldFocused?t("Use Enter securely for the focused password or code field."):t("Click a page control or focus the viewport to type.")} {" "+t("Each input requires a current frame.")}</p></>}
 </section>;
}
