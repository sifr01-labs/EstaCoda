import {useI18n} from '../i18n.js';
import {useEffect,useState} from 'react';
import type {MethodContracts,TargetReference} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {Button,Icon} from './primitives.js';

type Changes=MethodContracts['diff.list']['result'];
export function ChangesView({api,target}:{api:DesktopApi;target?:TargetReference|null}){
 const {t,status}=useI18n();
 const [revision,refresh]=useState(0),[ready,setReady]=useState(true),[error,setError]=useState(false),[patchError,setPatchError]=useState(false),[changes,setChanges]=useState<Changes|null>(null),[selected,setSelected]=useState<Changes['items'][number]|null>(null),[patch,setPatch]=useState<MethodContracts['diff.patch']['result']|null>(null);
 const available=!!target&&!!api.diff;
 useEffect(()=>api.onSnapshot(snapshot=>{if(snapshot.status!=='ready'){setReady(false);setChanges(null);setSelected(null);setPatch(null);}}),[api]);
 useEffect(()=>{
  let current=true;setChanges(null);setSelected(null);setPatch(null);setError(false);setPatchError(false);
  if(ready&&target&&api.diff)void api.diff.list({target}).then(value=>{if(current)setChanges(value);}).catch(()=>{if(current)setError(true);});
  return()=>{current=false;};
 },[api,target?.targetId,target?.targetGeneration,revision,ready]);
 useEffect(()=>{
  let current=true;setPatch(null);setPatchError(false);
  if(selected&&ready&&target&&api.diff)void api.diff.patch({target,path:selected.path,stage:selected.stage}).then(value=>{if(current)setPatch(value);}).catch(()=>{if(current)setPatchError(true);});
  return()=>{current=false;};
 },[api,target?.targetId,target?.targetGeneration,selected,ready]);
 const loading=available&&ready&&!changes&&!error;
 const empty=(icon:string,title:string,description:string,role?:'alert'|'status')=><div className="ec-changes-empty" role={role}><span className="ec-changes-emblem"><Icon name={icon}/></span><h3>{title}</h3><p>{description}</p></div>;
 const total=changes?new Set(changes.items.map(item=>item.path)).size:0;
 return <section className="ec-changes-view" aria-label={t('Workspace changes')}>
  <header className="ec-changes-header"><div className="ec-changes-title"><span className="ec-changes-mark"><Icon name="git-compare-arrows"/></span><div><h2>{t('Workspace changes')}</h2><p>{t('Review the current edits in this workspace.')}</p></div></div><Button icon="refresh-cw" disabled={!ready||!available||loading} onClick={()=>refresh(value=>value+1)}>{t('Refresh changes')}</Button></header>
  <div className="ec-changes-meta"><span><Icon name="eye"/>{t('Read only')}</span>{changes&&<span>{t('Files changed: {count}',{count:total})}</span>}</div>
  {!ready?empty('plug',t('Changes disconnected'),t('Reconnect, then reopen this tab to review workspace changes.'),'alert'):
   !available?empty('folder',t('A Git workspace is needed'),t('Changes are available for chats in a trusted Git workspace.')):
   error?empty('folder',t('Changes aren’t available'),t('This workspace must be a trusted Git repository accessible to this chat. Check the workspace, then refresh.'),'alert'):
   loading?empty('git-compare-arrows',t('Loading changes…'),t('Checking the workspace for edits.'),'status'):
   changes&&!changes.items.length?empty('file-check',t('No changes to review'),t('Your workspace has no visible staged, unstaged, or new files.')):
   changes&&<div className="ec-changes-review"><nav className="ec-changes-files" aria-label={t('Changed files')}>
    {(['staged','unstaged','untracked'] as const).map(stage=>{const rows=changes.items.filter(item=>item.stage===stage);return rows.length?<div className="ec-changes-group" key={stage}><h3>{status(stage)}<span>{rows.length}</span></h3>{rows.map(item=><button type="button" className="ec-changedfile" key={item.path} disabled={!item.previewable} aria-pressed={selected?.path===item.path&&selected.stage===item.stage} onClick={()=>setSelected(item)}><Icon name="file-text"/><span className="ec-changes-filecopy"><bdi dir="auto">{item.path}</bdi>{item.previousPath&&<small dir="auto">{item.previousPath} → {item.path}</small>}<small>{status(item.status)}{!item.previewable?' '+t('· Preview unavailable'):''}</small></span><Icon name="chevron-right"/></button>)}</div>:null;})}
   </nav><section className="ec-changes-preview" aria-label={t('File preview')}>
    {!selected?empty('file-text',t('Select a file'),t('Choose a changed file to inspect its patch.')):<><div className="ec-changes-patchhead"><bdi dir="auto">{selected.path}</bdi><span>{status(selected.stage)}</span></div>
    {patchError?empty('circle-alert',t('Preview unavailable'),t('Refresh changes to inspect the latest version of this file.'),'alert'):
     !patch?<div className="ec-changes-patchloading" role="status">{t('Loading preview…')}</div>:
     patch.binary?empty('file',t('Binary file changed'),t('This file can’t be displayed as a text patch.')):
     <pre className="ec-changes-code" dir="ltr" tabIndex={0} aria-label={t('File patch')}><code>{patch.text?.split('\n').map((line,index)=><span key={index} className={line.startsWith('@@')||line.startsWith('+++')||line.startsWith('---')?'ec-patch-meta':line.startsWith('+')?'ec-patch-added':line.startsWith('-')?'ec-patch-removed':undefined}>{line}{'\n'}</span>)}</code></pre>}
    {patch?.truncated&&<p className="ec-changes-limit">{t('This patch is truncated. Some changes are not displayed.')}</p>}</>}
   </section></div>}
  {changes?.truncated&&<p className="ec-changes-limit">{t('First 32 changes shown. Additional changes are not displayed.')}</p>}
  <p className="ec-changes-footnote">{t('Includes workspace edits made outside this chat. Activity records what the agent did.')}</p>
 </section>;
}
