import {useEffect,useRef,useState} from 'react';
import {humanBrowserKey,type BrowserViewReference,type HumanBrowserFrame,type HumanBrowserInput} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {Button,Badge} from './primitives.js';
export function BrowserTakeover({api,workId,reference,active}:{api:NonNullable<DesktopApi['browserControl']>;workId:string;reference:BrowserViewReference;active:(value:boolean)=>void}){
 const[id,setId]=useState<string>(),[frame,setFrame]=useState<HumanBrowserFrame>(),[busy,setBusy]=useState(false),[error,setError]=useState('');const handle=useRef<string|undefined>(undefined),epoch=useRef(0);
 useEffect(()=>()=>{epoch.current++;if(handle.current)void api.abandon(handle.current).catch(()=>{});active(false);},[api,active]);
 const failure=()=>{if(handle.current)void api.abandon(handle.current).catch(()=>{});handle.current=undefined;setId(undefined);setFrame(undefined);active(false);setError('Control unavailable or uncertain. Browser execution remains paused if takeover began. Reacquire control to inspect or explicitly return it to the agent.');};
 const open=async()=>{const revision=++epoch.current;setBusy(true);setError('');try{const value=await api.open(workId,reference);if(revision!==epoch.current){void api.abandon(value.id);return;}handle.current=value.id;setId(value.id);active(true);}catch{if(revision===epoch.current)failure();}finally{if(revision===epoch.current)setBusy(false);}};
 const refresh=async(input?:HumanBrowserInput)=>{if(!id||busy)return;const revision=++epoch.current;setBusy(true);setError('');try{const value=await api.frame(id,input);if(revision===epoch.current)setFrame(value);}catch{if(revision===epoch.current)failure();}finally{if(revision===epoch.current)setBusy(false);}};
 const release=async()=>{if(!id||busy)return;const revision=++epoch.current;setBusy(true);try{await api.release(id);if(revision===epoch.current){handle.current=undefined;setId(undefined);setFrame(undefined);active(false);setError('Control returned to the agent.');}}catch{if(revision===epoch.current)failure();}finally{if(revision===epoch.current)setBusy(false);}};
 return <section className="ec-browsercontrol" aria-label="Browser control">
  <Badge>{id?'You control this browser':'Human takeover'}</Badge>
  <p className="ec-footnote">Takeover supports existing supervised local browsers. Closing this view leaves browser execution paused; use Return to agent when finished.</p>
  {!id?<Button disabled={busy} onClick={()=>void open()}>Take control</Button>:<><Button disabled={busy} onClick={()=>void refresh()}>Refresh live view</Button><Button disabled={busy} onClick={()=>void release()}>Return to agent</Button></>}
  {error&&<p role="status">{error}</p>}{id&&!frame&&!busy&&<p>Refresh the live view to enable pointer and keyboard input.</p>}{busy&&<p role="status">Waiting for browser…</p>}
  {id&&frame&&<><p className="ec-browserurl"><bdi>{frame.url}</bdi></p><div tabIndex={0} role="group" aria-busy={busy} aria-label="Controlled browser viewport" onKeyDown={event=>{if(event.key==='Escape'||event.ctrlKey||event.metaKey||event.altKey||event.nativeEvent.isComposing||!humanBrowserKey(event.key))return;event.preventDefault();void refresh({kind:'key',frameId:frame.frameId,key:event.key});}}>
   <img src={'data:image/jpeg;base64,'+frame.image} alt="Live sanitized browser viewport" onClick={event=>{event.currentTarget.parentElement?.focus();const rect=event.currentTarget.getBoundingClientRect();const x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;if(x>=0&&x<1&&y>=0&&y<1)void refresh({kind:'pointer',frameId:frame.frameId,x,y});}}/>
  </div><p className="ec-footnote">Observed <bdi>{frame.observedAt}</bdi>. Click a page control or focus the viewport to type. Each input requires a current frame.</p></>}
 </section>;
}
