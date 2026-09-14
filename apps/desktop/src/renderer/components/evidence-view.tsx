import {evidenceSummaries,evidenceLimitations} from '../../shared/i18n/evidence-copy.js';
import {useI18n} from '../i18n.js';
import {useEffect,useRef,useState} from 'react';
import type {ArtifactPreview,ArtifactProjection,ArtifactReference,EvidenceReport,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {Badge,Button,Icon} from './primitives.js';
import {WorkUsage} from './work-usage.js';
import {DesktopMediaPreview} from './desktop-media-preview.js';
export function EvidenceView({api,work}:{api:DesktopApi;work:WorkProjection}){
 const {t,owned,status}=useI18n();
 const[output,setOutput]=useState<ArtifactPreview|null>(null),[report,setReport]=useState<EvidenceReport|null>(null),[artifacts,setArtifacts]=useState<Array<{reference:ArtifactReference;metadata:ArtifactProjection|null}>>([]),[error,setError]=useState(''),[outputError,setOutputError]=useState(''),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false);
 const epoch=useRef(0);
 useEffect(()=>{
  let current=true,revision=0,connected=true;++epoch.current;
  setReport(null);setArtifacts([]);setOutput(null);setError('');setOutputError('');setBusy(false);
  const load=async()=>{const request=++revision;setError('');try{
   const value=await api.evidence!.get(work.id);
   if(!current||revision!==request)return;setReport(value);
   const rows=await Promise.all(value.artifacts.map(async reference=>({reference,metadata:api.artifacts?.get?await api.artifacts.get(reference).then(value=>value.artifact).catch(()=>null):null})));
   if(current&&revision===request)setArtifacts(rows);
  }catch{if(current&&revision===request)setError('Evidence unavailable. Reconnect or refresh to try again.');}};
  if(api.evidence)void load();else setError('Evidence requires a compatible connection.');
  const unsubscribe=api.onSnapshot(snapshot=>{if(snapshot.status!=='ready'||snapshot.profile.id!==work.profileId){connected=false;revision++;epoch.current++;setReport(null);setArtifacts([]);setOutput(null);setBusy(false);setError('Evidence disconnected.');}else if(!connected&&api.evidence){connected=true;void load();}});
  return()=>{current=false;epoch.current++;unsubscribe();};
 },[api,work.id,work.profileId,work.updatedAt,refresh]);
 const open=async(reference:ArtifactReference)=>{if(!api.artifacts)return;const version=++epoch.current;setBusy(true);setOutput(null);setOutputError('');try{const value=await api.artifacts.open(reference);if(version===epoch.current)setOutput(value);}catch{if(version===epoch.current)setOutputError('Retained output unavailable.');}finally{if(version===epoch.current)setBusy(false);}};
 const save=async()=>{if(!output||!api.artifacts?.save)return;const version=epoch.current;setBusy(true);try{await api.artifacts.save(output.artifact.reference);}catch{if(version===epoch.current)setOutputError('Retained output unavailable.');}finally{if(version===epoch.current)setBusy(false);}};
 const changes=report?.facts.filter(fact=>['mutation','unverified_mutation'].includes(fact.kind))??[];
 const verified=changes.filter(fact=>!!fact.verifiedBy).length;
 const conversationOnly=report?.limitationCodes?.includes('conversation_only')===true&&report.facts.length===0;
 return <section className="ec-results" aria-label={t('Completion and evidence')}><div className="ec-pagehead"><h2>{t('Results')}</h2><Button className="ec-ghost" icon="refresh-cw" onClick={()=>setRefresh(value=>value+1)} title={t('Refreshes saved evidence. Does not run another external action.')}>{t('Refresh evidence')}</Button></div>
 {error?<p role="alert">{owned(error)}</p>:!report?<p role="status">{t('Checking recorded evidence…')}</p>:<>
 <div className="ec-result-outcome"><Icon name={report.completion==='completed'?'check':'circle-alert'}/><span>{status(report.completion)}</span>{!conversationOnly&&<Badge kind={report.state==='verified'?'good':''}>{report.state==='verified'?t('Verified evidence'):report.state==='partial'?t('Partial evidence'):report.state==='failed'?t('Failed execution'):t('Unverified evidence')}</Badge>}</div>
 <section className="ec-result-section"><h3>{t('Summary')}</h3><p>{conversationOnly?t('This exchange produced a conversation response. No external changes were recorded.'):t(evidenceSummaries[report.summaryCode??'']??'Evidence details require a compatible runtime. Inspect the recorded result before relying on its effects.')}</p></section>
 {!!report.artifacts.length&&<section className="ec-result-section"><h3>{t('Artifacts')}</h3>{!artifacts.length?<p role="status">{t('Loading artifacts…')}</p>:artifacts.map(({reference,metadata},index)=><article className="ec-result-artifact" key={JSON.stringify(reference)}><Icon name="file-text"/><div><b dir="auto">{metadata?.displayName??t('Retained output {number}',{number:index+1})}</b>{metadata&&<small><bdi>{metadata.mimeType}</bdi> · {metadata.bytes.toLocaleString()} {t('bytes')}</small>}</div><Button disabled={busy||!api.artifacts} onClick={()=>void open(reference)} aria-label={t('Open')+' '+(metadata?.displayName??t('Retained output {number}',{number:index+1}))}>{t('Open')}</Button></article>)}</section>}
 {!!changes.length&&<section className="ec-result-section"><h3>{t('Recorded changes')}</h3>{changes.map((fact,index)=><div className="ec-result-change" key={fact.callId+':'+index}><Icon name={fact.verifiedBy?'circle-check':'circle-alert'}/><bdi>{fact.tool}</bdi><span>{fact.verifiedBy?t('Verified'):t('Unverified')}</span></div>)}</section>}
 {!conversationOnly&&(report.facts.length>0||report.state!=='verified')&&<section className="ec-result-section"><h3>{t('Evidence')}</h3>{changes.length>0&&<p>{t('{verified} verified · {unverified} unverified change records',{verified,unverified:changes.length-verified})}</p>}<details><summary>{t('Recorded checks')}</summary>{report.facts.map((fact,index)=><div className="ec-resultline" key={fact.callId+':'+index}><Icon name={fact.verifiedBy?'circle-check':'clipboard-list'}/><span><bdi>{fact.tool}</bdi> · {status(fact.kind)}{fact.verifiedBy&&<small> {t('· validated by')} <bdi>{fact.verifiedBy}</bdi></small>}</span></div>)}{(report.limitationCodes??[]).map(line=><p className="ec-footnote" key={line}>{t(evidenceLimitations[line]??'Evidence details require a compatible runtime. Inspect the recorded result before relying on its effects.')}</p>)}</details></section>}
 {report.truncated&&<p role="status">{t('Only bounded evidence is shown.')}</p>}
 {api.work&&<WorkUsage key={work.profileId+work.id} api={api.work} work={work} context={false}/>}
 </>}
 {busy&&<p role="status">{t('Loading…')}</p>}{outputError&&<p role="alert">{owned(outputError)}</p>}
 {output&&<article className="ec-docpreview"><div className="ec-pagehead"><h3 dir="auto">{output.artifact.displayName}</h3><Button className="ec-ghost" icon="x" onClick={()=>setOutput(null)}>{t('Close')}</Button></div><p>{t('Integrity:')} {status(output.integrity)}</p>{api.artifacts&&output.integrity==='verified'&&<><DesktopMediaPreview api={api.artifacts} artifact={output.artifact}/>{api.artifacts.save&&<Button disabled={busy} onClick={()=>void save()}>{t('Save a copy…')}</Button>}</>}{output.text!==null?<pre dir="auto" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{output.text}</pre>:<p>{t('Binary output. Text preview unavailable.')}</p>}{output.truncated&&<p>{t('Preview truncated to 16 KiB.')}</p>}</article>}
 {!conversationOnly&&report&&<p className="ec-footnote">{t('Artifact integrity confirms retained bytes. Execution evidence establishes only the effects covered by recorded checks.')}</p>}
 </section>;
}
