import {useEffect,useRef,useState} from 'react';
import type {ActivityProjection,ArtifactPreview} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {Button,Icon} from './primitives.js';
import {fileSize} from './collection-ui.js';
import {DesktopMediaPreview} from './desktop-media-preview.js';
type Output=Extract<ActivityProjection,{kind:'artifact'}>;
export function RunOutputs({items,api,results}:{items:Output[];api?:DesktopApi;results:()=>void}){
 const {t,status}=useI18n();const [output,setOutput]=useState<ArtifactPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false),[connected,setConnected]=useState(true);const epoch=useRef(0),trigger=useRef<HTMLButtonElement|null>(null);
 const owner=items[0]?.profileId;
 useEffect(()=>{let alive=true;const unsubscribe=api?.onSnapshot(snapshot=>{if(!alive)return;const ready=snapshot.status==='ready'&&snapshot.profile.id===owner;setConnected(ready);if(!ready){epoch.current++;setOutput(null);setBusy(false);setError(false);}});return()=>{alive=false;epoch.current++;unsubscribe?.();};},[api,owner]);
 const open=async(item:Output,button:HTMLButtonElement)=>{if(!api?.artifacts||!connected)return;trigger.current=button;const version=++epoch.current;setBusy(true);setError(false);setOutput(null);try{const result=await api.artifacts.open(item.reference);if(epoch.current===version)setOutput(result);}catch{if(epoch.current===version)setError(true);}finally{if(epoch.current===version)setBusy(false);}};
 return <section className="ec-run-outputs" aria-label={t('Saved outputs')}><h3><Icon name="files"/>{t(items.length===1?'1 saved output':'{count} saved outputs',{count:items.length})}</h3><div className="ec-run-files">{items.map(item=><button type="button" key={item.id} disabled={busy||!connected||!api?.artifacts} onClick={event=>void open(item,event.currentTarget)} aria-label={t('Open')+' '+item.label}><Icon name="file-text"/><span><bdi>{item.label}</bdi><small><bdi>{item.mimeType}</bdi> · <bdi>{fileSize(item.bytes)}</bdi></small></span><Icon name="arrow-up-right"/></button>)}</div>
 {busy&&<p role="status">{t('Loading…')}</p>}{error&&<p role="alert">{t('Retained output unavailable.')}</p>}
 {output&&<article className="ec-run-preview"><div className="ec-pagehead"><h3 dir="auto">{output.artifact.displayName}</h3><Button className="ec-ghost" icon="x" onClick={()=>{epoch.current++;setOutput(null);trigger.current?.focus();}}>{t('Close')}</Button></div><p>{t('Integrity:')} {status(output.integrity)}</p>{api?.artifacts&&output.integrity==='verified'&&<DesktopMediaPreview api={api.artifacts} artifact={output.artifact}/ >}{output.text!==null?<pre dir="auto">{output.text}</pre>:<p>{t('Binary output. Text preview unavailable.')}</p>}{output.truncated&&<p>{t('Preview truncated to 16 KiB.')}</p>}</article>}
 <Button className="ec-ghost ec-run-results" icon="arrow-up-right" onClick={results}>{t('View in Results')}</Button></section>;
}
