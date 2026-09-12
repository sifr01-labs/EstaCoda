import {useI18n} from '../i18n.js';
import {BrowserWatch} from './browser-watch.js';
import {BrowserTakeover} from './browser-takeover.js';
import {useEffect,useRef,useState} from 'react';
import type {BrowserViewState,BrowserViewSnapshot,ArtifactPreview,ArtifactReference,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {Button,Badge,Icon} from './primitives.js';
export function BrowserView({api,work,close}:{api:DesktopApi;work:WorkProjection;close:()=>void}){
 const {t,owned,status}=useI18n();
 const[controlling,setControlling]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),epoch=useRef(0),[ready,setReady]=useState(true),[refresh,setRefresh]=useState(0);
 const[items,setItems]=useState<BrowserViewState[]|null>(null),[selected,setSelected]=useState<BrowserViewState|null>(null),[snapshot,setSnapshot]=useState<BrowserViewSnapshot|null>(null),[output,setOutput]=useState<ArtifactPreview|null>(null),[error,setError]=useState(''),[truncated,setTruncated]=useState(false);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{epoch.current++;dialog.current?.close();previous?.focus();};},[]);
 useEffect(()=>api.onSnapshot(value=>{if(value.status!=='ready'||value.profile.id!==work.profileId){epoch.current++;setReady(false);setItems(null);setSelected(null);setSnapshot(null);setOutput(null);setError('Browser view disconnected. Close and reopen after reconnecting.');}}),[api,work.profileId]);
 useEffect(()=>{const revision=++epoch.current;setItems(null);setSelected(null);setSnapshot(null);setOutput(null);if(!ready)return;setError('');
  void api.browser?.list(work.id).then(value=>{if(revision===epoch.current){setItems(value.items);setTruncated(value.truncated);}}).catch(()=>{if(revision===epoch.current)setError('Browser observations are unavailable. Select a current, trusted workspace.');});
  return()=>{epoch.current++;};
 },[api,work.id,work.target?.targetId,work.target?.targetGeneration,ready,refresh]);
 const open=async(item:BrowserViewState)=>{const revision=++epoch.current;setSelected(item);setSnapshot(null);setOutput(null);setError('');try{const value=await api.browser!.snapshot(work.id,item.reference);if(revision===epoch.current){setSnapshot(value);setSelected(value.state);}}catch{if(revision===epoch.current)setError('Browser observation changed. Refresh the list.');}};
 const artifact=async(reference:ArtifactReference)=>{const revision=++epoch.current;setOutput(null);try{const value=await api.artifacts?.open(reference);if(revision===epoch.current&&value)setOutput(value);}catch{if(revision===epoch.current)setError('Retained browser output unavailable.');}};
 return <dialog ref={dialog} className="ec-filedialog ec-browserdialog" aria-labelledby="ec-browser-title" onCancel={close}>
  <header><h2 id="ec-browser-title">{t("Browser")}</h2><Badge>{controlling?t("You control the browser"):api.browserControl?.watch?t("Browser views"):t("Recorded view")}</Badge><Button className="ec-ghost ec-iconbutton" icon="x" aria-label={t("Close browser view")} onClick={close}/></header>
  <p className="ec-footnote">{t("Latest recorded observations from this Work. Refresh checks for new observations; it does not navigate, capture a page, or take control.")}</p>
  <Button disabled={!ready||controlling} icon="refresh-cw" onClick={()=>setRefresh(value=>value+1)}>{t("Refresh browser view")}</Button>
  {error&&<p role="alert">{owned(error)}</p>}
  <div className="ec-filelayout"><nav aria-label={t("Browser sessions")}>
   {!items&&!error&&<p role="status">{t("Loading browser sessions…")}</p>}
   {items?.length===0&&<p className="ec-footnote">{t("No recorded browser sessions for this Work.")}</p>}
   {items?.map(item=><button key={item.reference.browserId} disabled={!ready||controlling} aria-current={selected?.reference.browserId===item.reference.browserId?'true':undefined} onClick={()=>void open(item)}><Icon name="globe"/><span dir="auto">{item.title??(item.state==='blocked'?t("Observation withheld"):item.reference.browserId)}</span></button>)}
   {truncated&&<p className="ec-footnote">{t("Showing up to 8 browser sessions from the latest 64 browser events.")}</p>}
  </nav><section aria-label={t("Browser observation")}>
   {api.browserControl?.watch&&ready&&<BrowserWatch api={api.browserControl} workId={work.id} controlling={controlling}/>}
   {api.browserControl?.workspace&&ready&&<BrowserTakeover api={api.browserControl} workId={work.id} active={setControlling}/>}
   {!selected?<p className="ec-footnote">{t("Select a browser session to inspect its recorded state.")}</p>:<>
    <h3 dir="auto">{selected.title??t("Browser observation")}</h3>
    {selected.url&&<p className="ec-browserurl"><bdi dir="ltr">{selected.url}</bdi></p>}
    <p className="ec-footnote">{t("Observed:")+" "}<bdi dir="ltr">{selected.observedAt}</bdi> · {status(selected.readiness)} · <bdi>{selected.lastAction}</bdi></p>
    {api.browserControl&&!api.browserControl.workspace&&selected.state==='recorded'&&<BrowserTakeover key={selected.reference.browserId} api={api.browserControl} workId={work.id} reference={selected.reference} active={setControlling}/>}
    {!controlling&&(snapshot?.image?<figure><img src={'data:image/jpeg;base64,'+snapshot.image.base64} alt={t("Sanitized recorded browser viewport")}/><figcaption className="ec-footnote">{t("Capture:")+" "}<bdi dir="ltr">{snapshot.image.observedAt}</bdi> {" "+t("· Bounded preview")}</figcaption></figure>:<p className="ec-footnote">{snapshot?.reason||error?t("Preview unavailable. Refresh to inspect the current state."):t("Checking retained capture…")}</p>)}
    {selected.artifacts.map((reference,index)=><Button key={JSON.stringify(reference)} disabled={!ready||!snapshot||!api.artifacts} icon="file-text" onClick={()=>void artifact(reference)}>{t("Inspect Work artifact")+" "}{index+1}</Button>)}
    {output&&<article className="ec-docpreview"><h3 dir="auto">{output.artifact.displayName}</h3><p>{t("Integrity:")+" "}{status(output.integrity)}</p><pre dir="auto">{output.text??t("Binary artifact. Text preview unavailable.")}</pre>{output.truncated&&<p>{t("Preview truncated.")}</p>}</article>}
   </>}
  </section></div>
 </dialog>;
}
