import {useEffect,useState} from 'react';
import type {HumanBrowserFrame,BrowserWorkspaceState} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {Button} from './primitives.js';
/** Current, bounded observations through the existing runtime; never acquires input authority. */
export function BrowserWatch({api,workId,controlling}:{api:NonNullable<DesktopApi['browserControl']>;workId:string;controlling:boolean}){
 const[watching,setWatching]=useState(false),[selected,setSelected]=useState(''),[workspace,setWorkspace]=useState<BrowserWorkspaceState>(),[frame,setFrame]=useState<HumanBrowserFrame>(),[status,setStatus]=useState('');
 useEffect(()=>{
  let live=true,timer:ReturnType<typeof setTimeout>|undefined;
  setFrame(undefined);
  if(!watching||controlling)return;
  const poll=async()=>{
   try{
    const inventory=await api.inventory!(workId);if(!live)return;setWorkspace(inventory);
    if(!inventory.supported){setFrame(undefined);setStatus(inventory.reason??'Live viewing unavailable. Recorded views remain available.');return;}
    const browserId=inventory.sessions.find(session=>session.id===selected)?.id??inventory.sessions[0]?.id;
    if(!browserId){setFrame(undefined);setStatus('No current browser sessions. Waiting for browser work…');return;}
    const observation=await api.watch!(workId,browserId);if(!live)return;setFrame(observation);setStatus('');
   }catch{if(live){setFrame(undefined);setStatus('Current observation unavailable while the browser is busy or disconnected. Retrying…');}}
   finally{if(live)timer=setTimeout(()=>void poll(),2000);}
  };
  void poll();return()=>{live=false;clearTimeout(timer);};
 },[api,workId,watching,selected,controlling]);
 if(!api.watch||!api.inventory)return null;
 return <section className="ec-browserwatch" aria-label="Live browser observation">
  <Button disabled={controlling} onClick={()=>setWatching(value=>!value)}>{watching?'Stop watching':'Watch live'}</Button>
  {controlling?<p className="ec-footnote">Live watching resumes after Return to agent.</p>:watching&&<>
   {!!workspace?.sessions.length&&<label>Watch session <select aria-label="Watch browser session" value={workspace.sessions.some(s=>s.id===selected)?selected:workspace.sessions[0]?.id} onChange={event=>{setFrame(undefined);setSelected(event.target.value);}}>{workspace.sessions.map(session=><option key={session.id} value={session.id}>{session.tabs.find(tab=>tab.controlled)?.title??session.id}</option>)}</select></label>}
   {status&&<p role="status">{status}</p>}
   {frame&&<figure><img src={'data:image/jpeg;base64,'+frame.image} alt="Current sanitized browser observation"/><figcaption className="ec-browserurl"><bdi>{frame.url}</bdi> · {frame.readiness??'unknown'} · Observed <bdi>{frame.observedAt}</bdi></figcaption></figure>}
   <p className="ec-footnote">Updates between browser actions. Viewing does not take control.</p>
  </>}
 </section>;
}
