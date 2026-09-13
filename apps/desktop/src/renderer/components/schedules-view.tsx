import {ScheduleActions} from './schedule-actions.js';
import {ScheduleEditor} from './schedule-editor.js';
import {useEffect,useState,useRef} from 'react';
import type {ScheduleProjection,ScheduleExecutionProjection} from '@estacoda/control-protocol';
import type {DesktopSchedulesApi,DesktopWorkApi} from '../../shared/desktop-api.js';
import {Button,Badge,Icon} from './primitives.js';
import {useI18n} from '../i18n.js';
export function SchedulesView({api,ready,select,work}:{api?:DesktopSchedulesApi;work?:DesktopWorkApi;ready:boolean;select:(id:string)=>void}){
 const editorOrigin=useRef<HTMLButtonElement|null>(null);
 const closeEditor=()=>{setEditing(undefined);requestAnimationFrame(()=>editorOrigin.current?.focus());};
 const[editing,setEditing]=useState<string|null|undefined>(undefined);
 const {status,owned:label}=useI18n();
 const[rows,setRows]=useState<ScheduleProjection[]>([]),[next,setNext]=useState<number|null>(null),[selected,setSelected]=useState<string>(),[history,setHistory]=useState<ScheduleExecutionProjection[]>([]),[historyNext,setHistoryNext]=useState<number|null>(null),[historyAvailable,setHistoryAvailable]=useState<boolean|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;setRows([]);setSelected(undefined);setError('');setLoading(true);if(api&&ready)void api.list().then(page=>{if(active){setRows(page.items);setNext(page.nextOffset);}}).catch(()=>{if(active)setError('Schedules unavailable. Reconnect or refresh.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[api,ready]);
 useEffect(()=>{let active=true;setHistory([]);setHistoryNext(null);setHistoryAvailable(null);if(api&&ready&&selected)void api.history(selected).then(page=>{if(active){setHistory(page.items);setHistoryNext(page.nextOffset);setHistoryAvailable(page.available);}}).catch(()=>{if(active)setHistoryAvailable(false);});return()=>{active=false;};},[api,ready,selected]);
 const selectedRef=useRef(selected);selectedRef.current=selected;
 const[historyBusy,setHistoryBusy]=useState(false);
 const job=rows.find(r=>r.id===selected);
 if(!ready||!api)return <p className="ec-footnote">{label('Schedules unavailable. Reconnect or refresh.')}</p>;
 return <section aria-label={label('Schedules')}>
 {<Button disabled={editing!==undefined} onClick={e=>{editorOrigin.current=e.currentTarget;setEditing(null);}}>{label('New schedule')}</Button>}
 {editing!==undefined&&<ScheduleEditor key={editing??'new'} api={api} work={work} id={editing??undefined} onClose={closeEditor} onSaved={()=>{closeEditor();setSelected(undefined);setLoading(true);void api.list().then(page=>{setRows(page.items);setNext(page.nextOffset);}).catch(()=>setError('Schedules unavailable. Reconnect or refresh.')).finally(()=>setLoading(false));}}/>}
 {error&&<p role="alert">{label(error)}</p>}
 <Button disabled={loading} onClick={()=>{setLoading(true);setError('');void api.list().then(page=>{setRows(page.items);setNext(page.nextOffset);setSelected(undefined);}).catch(()=>setError('Schedules unavailable. Reconnect or refresh.')).finally(()=>setLoading(false));}}>{label('Refresh schedules')}</Button>
 {loading?<p role="status">{label('Loading schedules…')}</p>:!rows.length&&!error?<p className="ec-footnote">{label('No schedules in this profile.')}</p>:rows.map(row=><button className="ec-libraryrow" key={row.id} aria-expanded={selected===row.id} onClick={()=>{setHistory([]);setHistoryAvailable(null);setHistoryNext(null);setSelected(selected===row.id?undefined:row.id);}}><Icon name="clock-3"/><span><bdi>{row.name}</bdi><small><bdi dir="ltr">{row.schedule}</bdi>{' · '}{row.nextRunAt?<bdi>{row.nextRunAt}</bdi>:label('No next run')}</small></span><Badge>{status(row.status)}</Badge></button>)}
 {next!==null&&<Button disabled={loading} onClick={()=>{setLoading(true);void api.list(next).then(page=>{setRows(old=>[...old,...page.items]);setNext(page.nextOffset);}).catch(()=>setError('Schedules unavailable. Reconnect or refresh.')).finally(()=>setLoading(false));}}>{label('Load more schedules')}</Button>}
 {job&&<div className="ec-detailpane"><h3><bdi>{job.name}</bdi></h3>{<Button disabled={editing!==undefined} onClick={e=>{editorOrigin.current=e.currentTarget;setEditing(job.id);}}>{label('Edit schedule')}</Button>}<ScheduleActions key={job.id} api={api} job={job} onChanged={()=>{setSelected(undefined);void api.list().then(page=>{setRows(page.items);setNext(page.nextOffset);}).catch(()=>setError('Schedules unavailable. Reconnect or refresh.'));}}/><p dir="auto">{job.objective}</p><dl><dt>{label('Workspace')}</dt><dd><bdi>{job.workspace??label('Runtime default workspace')}</bdi></dd><dt>{label('Model')}</dt><dd><bdi>{job.model?[job.model.provider,job.model.model].filter(Boolean).join('/'):label('Profile model at execution')}</bdi></dd><dt>{label('Delivery')}</dt><dd><bdi>{job.delivery}</bdi></dd><dt>{label('Last result')}</dt><dd>{job.lastStatus?status(job.lastStatus):label('Not run')}</dd></dl>{job.runRequested&&<p>{label('Run requested; execution has not been confirmed.')}</p>}
 <h4>{label('Execution history')}</h4>{historyAvailable===null?<p role="status">{label('Loading history…')}</p>:!historyAvailable?<p>{label('History unavailable.')}</p>:!history.length?<p>{label('No attributable executions. Older unowned history is not shown.')}</p>:history.map(run=><div className="ec-settingsrow" key={run.id}><div><bdi>{run.startedAt}</bdi><p>{status(run.status)}{run.failure&&<> · <bdi>{status(run.failure)}</bdi></>}</p>{run.delivery.map((d,i)=><p key={i}><bdi>{d.destination}</bdi>{' · '}{label(d.success?'Delivered':'Delivery failed')}</p>)}</div>{run.workId&&<Button onClick={()=>select(run.workId!)}>{label('Open source Work')}</Button>}</div>)}
 {historyNext!==null&&<Button disabled={historyBusy} onClick={()=>{setHistoryBusy(true);void api.history(job.id,historyNext).then(page=>{if(selectedRef.current===job.id){setHistory(old=>[...old,...page.items]);setHistoryNext(page.nextOffset);}}).catch(()=>{if(selectedRef.current===job.id)setHistoryAvailable(false);}).finally(()=>setHistoryBusy(false));}}>{label('Load more history')}</Button>}
 </div>}
 <p className="ec-footnote">{label('The shared runtime owns scheduling. Closing Desktop does not stop it. Runs need an available, awake runtime; creating a schedule does not install or start a service.')}</p>
 </section>;
}
