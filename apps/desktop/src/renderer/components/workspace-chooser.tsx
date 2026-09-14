import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {OnboardingWorkspaceReview,TargetProjection,TargetReference} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {Button,Icon} from './primitives.js';

/** Folder selection is inert. Registration and trust go through the existing reviewed setup operation. */
export function WorkspaceChooser({items,onboarding,targets,select,close,manage,truncated}:{items:TargetProjection[];onboarding?:DesktopApi['onboarding'];targets?:DesktopApi['targets'];select:(target:TargetReference)=>void;close:()=>void;manage?:()=>void;truncated:boolean}){
 const {t}=useI18n();
 const dialog=useRef<HTMLDialogElement>(null),epoch=useRef(0),pending=useRef<OnboardingWorkspaceReview|undefined>(undefined);
 const [query,setQuery]=useState(''),[folder,setFolder]=useState<{path:string;alias:string}>(),[trust,setTrust]=useState(false),[review,setReview]=useState<OnboardingWorkspaceReview>(),[busy,setBusy]=useState(false),[outcome,setOutcome]=useState(false),[error,setError]=useState(false);
 const closeRef=useRef(close);closeRef.current=close;
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;const node=dialog.current!;node.showModal();
  const unsubscribe=window.desktop?.onSnapshot?.(snapshot=>{if(snapshot.status!=='ready')closeRef.current();});
  return()=>{epoch.current++;unsubscribe?.();node.close();previous?.focus();if(pending.current)void onboarding?.cancelWorkspace(pending.current.reviewId).catch(()=>{});pending.current=undefined;};
 },[onboarding]);
 const run=async(action:(current:()=>boolean)=>Promise<void>)=>{
  if(busy)return;const ticket=epoch.current;const current=()=>epoch.current===ticket;
  setBusy(true);setError(false);try{await action(current);}catch{if(current())setError(true);}finally{if(current())setBusy(false);}
 };
 const choose=()=>void run(async current=>{const value=await onboarding!.chooseWorkspace();if(current()&&value){setFolder(value);setTrust(false);}});
 const reviewFolder=()=>void run(async current=>{
  if(!folder||!trust)return;const value=await onboarding!.reviewWorkspace(folder.alias,true);
  if(!current()){void onboarding!.cancelWorkspace(value.reviewId).catch(()=>{});return;}
  pending.current=value;setReview(value);
 });
 const verify=async(current:()=>boolean)=>{
  const value=await onboarding!.verify(review?.alias??folder?.alias);
  if(!current())return;
  if(value.target&&value.detection.launchReady&&targets){const inspected=await targets.inspect(value.target);if(!current())return;if(inspected.workingRoot===review?.path&&inspected.readiness==='ready'){select(value.target);close();return;}}
  setError(true);
 };
 const apply=()=>void run(async current=>{
  if(!review?.trust)return;
  // Never offer a second Apply after a lost response. Check saved state without replaying the mutation.
  setOutcome(true);
  const receipt=await onboarding!.applyWorkspace(review.reviewId,true);
  if(current()&&receipt.state==='completed'){pending.current=undefined;await verify(current);}
 });
 const back=()=>void run(async current=>{if(pending.current)await onboarding!.cancelWorkspace(pending.current.reviewId);if(current()){pending.current=undefined;setReview(undefined);setFolder(undefined);setTrust(false);}});
 return createPortal(<dialog ref={dialog} className="ec-workspacechooser ec-modal" aria-labelledby="ec-workspace-title" onCancel={event=>{event.preventDefault();close();}}>
  <div className="ec-targetheading"><h2 id="ec-workspace-title">{review?t('Review workspace'):folder?t('Add a workspace'):t('Choose a workspace')}</h2><Button className="ec-ghost ec-iconbutton" icon="x" aria-label={t('Close workspace picker')} onClick={close}/></div>
  {error&&<p role="alert">{t('Workspace not confirmed. Check the saved workspace or choose the folder again. Your draft is preserved.')}</p>}
  {outcome?<><p role="status">{t('Check the saved workspace before continuing. This does not repeat the trust operation.')}</p><Button disabled={busy} onClick={()=>void run(verify)}>{t('Check workspace')}</Button></>:review?<>
   <p>{t('EstaCoda will register this folder and trust it for agent execution. Your approval policy still applies. Local execution is not sandboxed.')}</p>
   <dl className="ec-targetfacts"><dt>{t('Workspace')}</dt><dd><bdi>{review.alias}</bdi></dd><dt>{t('Working directory')}</dt><dd><bdi dir="ltr">{review.path}</bdi></dd></dl>
   <div className="ec-targetactions"><Button disabled={busy} onClick={back}>{t('Back')}</Button><Button className="ec-primary" disabled={busy||!review.trust} onClick={apply}>{t('Trust and use workspace')}</Button></div>
  </>:folder?<>
   <p className="ec-folderpath"><bdi dir="ltr">{folder.path}</bdi></p>
   <label className="ec-field">{t('Workspace name')}<input value={folder.alias} dir="auto" maxLength={64} disabled={busy} onChange={event=>setFolder({...folder,alias:event.target.value})}/></label>
   <label className="ec-targettrust"><input type="checkbox" checked={trust} disabled={busy} onChange={event=>setTrust(event.target.checked)}/>{t('I trust this folder for agent execution. Approval rules still apply.')}</label>
   <div className="ec-targetactions"><Button disabled={busy} onClick={back}>{t('Back')}</Button><Button disabled={busy||!trust||!folder.alias.trim()} onClick={reviewFolder}>{t('Review workspace')}</Button></div>
  </>:<>
   <p>{t('Choose where EstaCoda can work with your files. You can write your prompt first.')}</p>
   {items.length>0&&<input type="search" aria-label={t('Find a workspace')} placeholder={t('Find a workspace')} value={query} onChange={event=>setQuery(event.target.value)}/>}
   <div className="ec-targetlist">{items.filter(item=>item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item=><button key={item.targetId} type="button" disabled={busy} onClick={()=>{select(item);close();}}><Icon name="folder"/><span><bdi>{item.label}</bdi><small>{item.isolation==='host'?t('Local host'):t('Profile execution policy')}</small></span><Icon name="chevron-right"/></button>)}</div>
   {!items.length&&<p>{t('No workspaces yet. Add a folder to get started.')}</p>}
   {items.length>0&&!items.some(item=>item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))&&<p>{t('No matching workspaces.')}</p>}
   <div className="ec-targetactions">{onboarding&&targets&&<Button icon="plus" disabled={busy} onClick={choose}>{t('Add folder…')}</Button>}{manage&&<Button className="ec-ghost" disabled={busy} onClick={manage}>{t('Manage workspaces')}</Button>}</div>
   {(!onboarding||!targets)&&<p>{t('Folder setup is unavailable. Reconnect to add a workspace.')}</p>}{truncated&&<p>{t('More targets are available in Manage workspaces.')}</p>}
  </>}
 </dialog>,document.querySelector('#ec-branded-workspace .ec-window')??document.body);
}
