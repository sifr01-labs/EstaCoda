import {useI18n} from '../i18n.js';
import {useEffect,useState} from 'react';
import type {ArtifactPreview,EvidenceReport,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {Badge,Button,Icon} from './primitives.js';
export function EvidenceView({api,work}:{api:DesktopApi;work:WorkProjection}){
 const {t,owned,status}=useI18n();
 const[outputReference,setOutputReference]=useState<import('@estacoda/control-protocol').ArtifactReference|null>(null);
 const[output,setOutput]=useState<ArtifactPreview|null>(null),[report,setReport]=useState<EvidenceReport|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{setReport(null);setOutput(null);setOutputReference(null);setError('');},[api,work.id,work.profileId]);
 useEffect(()=>{
  let current=true,revision=0,connected=true;
  const load=async()=>{const request=++revision;setError('');try{const value=await api.evidence!.get(work.id);if(current&&revision===request)setReport(value);}catch{if(current&&revision===request)setError('Evidence unavailable. Reconnect or refresh to try again.');}};
  if(api.evidence)void load();else setError('Evidence requires a compatible connection.');
  const unsubscribe=api.onSnapshot(snapshot=>{if(snapshot.status!=='ready'||snapshot.profile.id!==work.profileId){connected=false;revision++;setReport(null);setOutput(null);setOutputReference(null);setError('Evidence disconnected.');}else if(!connected&&api.evidence){connected=true;void load();}});
  return()=>{current=false;revision++;unsubscribe();};
 },[api,work.id,work.profileId,work.updatedAt,refresh]);
 useEffect(()=>{let current=true;setOutput(null);if(outputReference&&api.artifacts)void api.artifacts.open(outputReference).then(value=>{if(current)setOutput(value);}).catch(()=>{if(current)setError('Retained output unavailable.');});return()=>{current=false;};},[api,outputReference]);
 return <section aria-label={t("Completion and evidence")}><div className="ec-pagehead"><h2>{t("Completion & evidence")}</h2><Button className="ec-ghost" icon="refresh-cw" onClick={()=>setRefresh(value=>value+1)}>{t("Refresh evidence")}</Button></div>{error?<p role="alert">{owned(error)}</p>:!report?<p role="status">{t("Checking recorded evidence…")}</p>:<><div className="ec-resultline"><Icon name={report.state==='verified'?'circle-check':'circle-alert'}/><span>{t("Completion:")+" "}{report.completion}</span><Badge kind={report.state==='verified'?'good':''}>{report.state==='verified'?t("Verified evidence"):report.state==='partial'?t("Partial evidence"):report.state==='failed'?t("Failed execution"):t("Unverified evidence")}</Badge></div><p dir="auto">{report.summary}</p>{report.facts.map((fact,index)=><div className="ec-resultline" key={fact.callId+':'+index}><Icon name={fact.verifiedBy?'circle-check':'clipboard-list'}/><span><bdi dir="ltr">{fact.tool}</bdi> · {fact.kind.replaceAll('_',' ')}{fact.verifiedBy&&<small> {" "+t("· validated by")+" "}<bdi dir="ltr">{fact.verifiedBy}</bdi></small>}</span></div>)}{report.artifacts.map((reference,index)=><Button key={JSON.stringify(reference)} icon="file-text" onClick={()=>setOutputReference(reference)}>{t("Preview retained output")+" "}{index+1}</Button>)}{output&&<article className="ec-docpreview"><h3 dir="auto">{output.artifact.displayName}</h3><p>{t("Integrity:")+" "}{output.integrity}</p>{output.text!==null?<pre dir="auto" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{output.text}</pre>:<p>{output.reason??t("Binary output. Text preview unavailable.")}</p>}{output.truncated&&<p>{t("Preview truncated to 16 KiB.")}</p>}</article>}{report.limitations.map(line=><p className="ec-footnote" key={line} dir="auto">{line}</p>)}{report.truncated&&<p role="status">{t("Only bounded evidence is shown.")}</p>}<p className="ec-footnote">{t("Artifact integrity confirms retained bytes. Execution evidence establishes only the effects covered by recorded checks.")}</p></>}</section>;
}
