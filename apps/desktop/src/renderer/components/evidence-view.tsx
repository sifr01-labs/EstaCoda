import {useEffect,useState} from 'react';
import type {EvidenceReport,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {Badge,Button,Icon} from './primitives.js';
export function EvidenceView({api,work}:{api:DesktopApi;work:WorkProjection}){
 const[report,setReport]=useState<EvidenceReport|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let current=true,revision=0;
  const load=async()=>{const request=++revision;setReport(null);setError('');try{const value=await api.evidence!.get(work.id);if(current&&revision===request)setReport(value);}catch{if(current&&revision===request)setError('Evidence unavailable. Reconnect or refresh to try again.');}};
  if(api.evidence)void load();else setError('Evidence requires a compatible connection.');
  const unsubscribe=api.onSnapshot(snapshot=>{if(snapshot.status!=='ready'||snapshot.profile.id!==work.profileId){revision++;setReport(null);setError('Evidence disconnected.');}else if(api.evidence)void load();});
  return()=>{current=false;revision++;unsubscribe();};
 },[api,work.id,work.profileId,work.updatedAt,refresh]);
 return <section aria-label="Completion and evidence"><div className="ec-pagehead"><h2>Completion & evidence</h2><Button className="ec-ghost" icon="refresh-cw" onClick={()=>setRefresh(value=>value+1)}>Refresh evidence</Button></div>{error?<p role="alert">{error}</p>:!report?<p role="status">Checking recorded evidence…</p>:<><div className="ec-resultline"><Icon name={report.state==='verified'?'circle-check':'circle-alert'}/><span>Completion: {report.completion}</span><Badge kind={report.state==='verified'?'good':''}>{report.state==='verified'?'Verified evidence':report.state==='partial'?'Partial evidence':report.state==='failed'?'Failed execution':'Unverified evidence'}</Badge></div><p dir="auto">{report.summary}</p>{report.facts.map((fact,index)=><div className="ec-resultline" key={fact.callId+':'+index}><Icon name={fact.verifiedBy?'circle-check':'clipboard-list'}/><span><bdi>{fact.tool}</bdi> · {fact.kind.replaceAll('_',' ')}{fact.verifiedBy&&<small> · validated by <bdi>{fact.verifiedBy}</bdi></small>}</span></div>)}{report.limitations.map(line=><p className="ec-footnote" key={line} dir="auto">{line}</p>)}{report.truncated&&<p role="status">Only bounded evidence is shown.</p>}<p className="ec-footnote">Artifact integrity confirms retained bytes. Execution evidence establishes only the effects covered by recorded checks.</p></>}</section>;
}
