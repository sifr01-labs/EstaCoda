import {useEffect,useRef,useState} from 'react';
import {Server} from 'lucide-react';
import type {GatewayAction,GatewayDiagnostics,ConnectionOperation} from '@estacoda/control-protocol';
import type {DesktopConnectionsApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {Button} from './primitives.js';
import {CapabilityCard,CapabilityFact} from './capability-card.js';
const labels={install:'Install and start',start:'Start gateway',stop:'Stop gateway',restart:'Restart gateway'} as const;
const unresolved=(r:ConnectionOperation|null|undefined)=>r?.state==='uncertain'||r?.state==='unknown';
export function TelegramGateway({api,onEditing}:{api:DesktopConnectionsApi;onEditing?:(editing:boolean)=>void}){
 const {t,status}=useI18n();
 const [expanded,setExpanded]=useState(false),[review,setReview]=useState<GatewayAction>(),[diagnostics,setDiagnostics]=useState<GatewayDiagnostics>(),[receipt,setReceipt]=useState<ConnectionOperation|null>(),[busy,setBusy]=useState(true),[error,setError]=useState(false),[lost,setLost]=useState(false);
 const alive=useRef(true),lock=useRef(false),heading=useRef<HTMLHeadingElement>(null),opener=useRef<HTMLElement|null>(null);
 useEffect(()=>{onEditing?.(expanded);if(expanded)heading.current?.focus();return()=>onEditing?.(false);},[expanded]);
 async function refresh(){const [d,r]=await Promise.all([api.diagnostics(),api.inspectOperation()]);if(alive.current){setDiagnostics(d);setReceipt(r);setLost(false);}return r;}
 useEffect(()=>{alive.current=true;void refresh().catch(()=>{if(alive.current)setError(true);}).finally(()=>{if(alive.current)setBusy(false);});return()=>{alive.current=false;};},[api]);
 async function action(run:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError(false);try{await run();}catch{if(alive.current){setError(true);setDiagnostics(undefined);}}finally{lock.current=false;if(alive.current)setBusy(false);}}
 const blocked=busy||lost||error||unresolved(receipt),running=diagnostics?.runtime==='running';
 const label=!diagnostics?t(busy?'Checking status…':'Unavailable'):t(running?'Running':diagnostics.service==='absent'?'Not installed':diagnostics.runtime==='stopped'?'Stopped':'Unavailable');
 const open=()=>{opener.current=document.activeElement as HTMLElement;setExpanded(true);};
 const close=()=>{setExpanded(false);setReview(undefined);requestAnimationFrame(()=>{const target=opener.current?.isConnected?opener.current:document.querySelector<HTMLElement>('[data-gateway-open]');target?.focus();});};
 const execute=()=>void action(async()=>{
  if(!review||lost)return;const choice=review;
  // Reconcile durable state before lifecycle writes. Lost responses never replay a command.
  const prior=await refresh();if(!alive.current||unresolved(prior))return;
  setLost(true);
  const result=await api.gateway(choice,true);if(!alive.current)return;
  setReceipt(result);setLost(false);setReview(undefined);await refresh();
 });
 const primary=running?'stop':diagnostics?.service==='absent'?'install':diagnostics?.runtime==='stopped'?'start':undefined;
 return <section className="ec-media-section" aria-label={t('Gateway controls')}>
 {expanded?<><Button className="ec-ghost ec-model-back" icon="arrow-left" disabled={busy} onClick={close}>{t('Back to Connections')}</Button><h2 className="ec-media-picker-title" ref={heading} tabIndex={-1}>{t('Agent gateway')}</h2><p className="ec-media-description">{t('Run shared work and channels independently of Desktop.')}</p></>:<><h2>{t('Background gateway')}</h2><p className="ec-media-description">{t('Keep shared work and channels available when Desktop is closed.')}</p></>}
 <CapabilityCard icon={<Server/>} title={t(expanded?'Background service':'Agent gateway')} description={t('Selected profile · Local host')} action={expanded?primary?<Button disabled={blocked} onClick={()=>setReview(primary)}>{t(labels[primary])}</Button>:<Button disabled={busy} onClick={()=>void action(async()=>{await refresh();})}>{t('Check status')}</Button>:<Button data-gateway-open onClick={open}>{t('Manage')}</Button>}><CapabilityFact icon={running?'circle-check':'circle-dashed'} tone={running?'good':undefined}>{label}</CapabilityFact>{!expanded&&<CapabilityFact icon="monitor">{t('Background service')}</CapabilityFact>}</CapabilityCard>
 {expanded&&<><div className="ec-media-row"><div>{t('Installation')}</div><span>{diagnostics?t(diagnostics.service==='installed'?'Installed as a user service':diagnostics.service==='absent'?'Not installed':'Unknown'):t('Checking status…')}</span></div>
 {review&&<section className="ec-connection-detail" aria-label={t('Review gateway action')}><h3>{t(labels[review])}</h3><p>{t('Running shared Work and channel delivery may be interrupted. This action affects the selected profile.')}</p><div className="ec-model-footeractions"><Button disabled={busy} onClick={()=>setReview(undefined)}>{t('Cancel')}</Button><Button className="ec-primary" disabled={blocked} onClick={execute}>{t('Confirm')+' '+t(labels[review])}</Button></div></section>}
 <details className="ec-model-advanced"><summary>{t('Advanced & diagnostics')}</summary><div className="ec-media-row"><div>{t('Service manager')}</div><bdi>{diagnostics?.manager??t('Unknown')}</bdi></div>{diagnostics&&<><div className="ec-media-row"><div>{t('Queued or claimed turns')}</div><span>{diagnostics.queuedTurns??t('Unavailable')}</span></div><div className="ec-media-row"><div>{t('Uncertain turns')}</div><span>{diagnostics.uncertainTurns??t('Unavailable')}</span></div><div className="ec-media-row"><div>{t('Recent delivery failures')}</div><span>{diagnostics.recentDeliveryFailures??t('Unavailable')}</span></div><p className="ec-footnote">{t('· last 100 records / 24 hours')}</p></>}<div className="ec-model-footeractions"><Button disabled={busy} onClick={()=>void action(async()=>{await refresh();})}>{t('Run diagnostics')}</Button><Button disabled={blocked||!running} onClick={()=>setReview('restart')}>{t('Restart gateway')}</Button></div>{receipt&&<p role="status">{t('Last operation')}: {status(receipt.state)}</p>}</details></>}
 {(error||lost||unresolved(receipt))&&<div role="status" className="ec-connection-detail"><p>{t('An operation may still be running. Check its status before another action.')}</p><Button disabled={busy} onClick={()=>void action(async()=>{await refresh();})}>{t('Check status')}</Button></div>}
 </section>;
}
