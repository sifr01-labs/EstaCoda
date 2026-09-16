import {useEffect, useRef, useState} from 'react';
import type {ConnectorStatus} from '@estacoda/control-protocol';
import type {DesktopConnectionsApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {Badge, Button,Icon} from './primitives.js';
import {CapabilityCard,CapabilityFact} from './capability-card.js';

export function ConnectorPanel({api, workId, close, compact=false,cards=false}: {cards?:boolean;compact?:boolean;api: Pick<DesktopConnectionsApi, 'connectors'>; workId?: string; close?: () => void}) {
  const {t} = useI18n();
  const [status, setStatus] = useState<ConnectorStatus>();
  const [manage,setManage]=useState(false);
  const [selected,setSelected]=useState<string>();
  const reconnectLock=useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const generation = useRef(0), sequence = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setStatus(undefined); setError(false); setBusy(false);setSelected(undefined);reconnectLock.current=false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true; const request=++sequence.current;
      try { const next = await api.connectors({action:'inspect', ...(workId ? {workId} : {})}); if(current===generation.current&&request===sequence.current){setStatus(next);setError(false);} }
      catch { if(current===generation.current&&request===sequence.current)setError(true); }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { ++generation.current; clearInterval(timer); };
  }, [api, workId]);
  const reconnect = async () => {
    if(reconnectLock.current||busy || !workId)return;
    reconnectLock.current=true;
    const current = generation.current, request=++sequence.current; setBusy(true); setError(false);
    try { const next = await api.connectors({action:'reconnect',workId}); if(current===generation.current&&request===sequence.current)setStatus(next); }
    catch { if(current===generation.current&&request===sequence.current)setError(true); }
    finally { if(current===generation.current){setBusy(false);reconnectLock.current=false;} }
  };
  const pending = busy || status?.state==='reconnecting';
  if(cards)return <div className="ec-service-cards" aria-label={t('Connectors')}>
    {!workId&&<p className="ec-footnote">{t('Choose a chat to inspect or reconnect its connectors.')}</p>}
    {!status&&!error&&<p role="status">{t('Loading connectors…')}</p>}{error&&<p role="alert">{t('Could not check connectors. Try again.')}</p>}
    {status?.items.map(item=><div key={item.id}><CapabilityCard icon={<Icon name="plug"/>} title={<bdi>{item.id.toLowerCase()==='postman'?'Postman':item.id}</bdi>} description={t(item.id.toLowerCase()==='postman'?'API collections and environments':'Tools available to this chat')} action={<Button aria-expanded={selected===item.id} onClick={()=>setSelected(selected===item.id?undefined:item.id)}>{t('Manage')}</Button>}><CapabilityFact icon={item.state==='ready'?'circle-check':item.state==='needs_attention'?'circle-alert':'circle-dashed'} tone={item.state==='ready'?'good':item.state==='needs_attention'?'warn':undefined}>{t(item.state==='ready'?'Ready · {count} tools':item.state==='disabled'?'Disabled':item.state==='needs_attention'?'Needs attention':'Not connected yet',{count:item.toolCount})}</CapabilityFact>{item.state==='needs_attention'&&<span>{t('Connector unavailable')}</span>}</CapabilityCard>
      {selected===item.id&&<div className="ec-connection-detail"><p>{t('Status and tools are specific to the selected chat.')}</p>{status.state==='busy'&&<p role="status">{t('Wait for this chat to finish before reconnecting.')}</p>}{(error||status.state==='failed'||status.state==='unavailable')&&<p role="status">{t('Connection status is unavailable. Reconnect to check again.')}</p>}<div className="ec-model-footeractions"><Button disabled={!workId||pending||status.state==='busy'||!status.items.some(i=>i.state!=='disabled')} onClick={()=>void reconnect()}>{t(pending?'Reconnecting connectors…':'Reconnect chat connectors')}</Button></div><p className="ec-footnote">{t('Refreshes all connectors in this chat. No message is sent.')}</p></div>}
    </div>)}{status?.items.length===0&&<p className="ec-footnote">{t('No connectors configured.')}</p>}
  </div>;
  return <section className={compact?"ec-connectorpanel ec-connector-summary":"ec-connectorpanel"} aria-label={t('Connectors')}>
    <div className="ec-connectorhead"><strong>{t(compact?'Connections':'Connectors')}</strong><div>
      <>{compact&&!!status?.items.length&&<Button className="ec-ghost" aria-expanded={manage} onClick={()=>setManage(value=>!value)}>{t('Manage connections')}</Button>}{(!compact||manage||error||status?.state==='failed'||status?.state==='unavailable'||status?.items.some(item=>item.state==='needs_attention')||pending)&&<Button className="ec-ghost" disabled={!workId||pending||status?.state==='busy'||!status?.items.some(item=>item.state!=='disabled')} onClick={()=>void reconnect()}>{pending?t('Reconnecting connectors…'):t('Reconnect connectors')}</Button>}</>
      {close&&<Button className="ec-ghost ec-iconbutton" icon="x" aria-label={t('Close')} onClick={close}/>}</div></div>
    {compact&&!status&&!error&&<p role="status">{t('Loading connectors…')}</p>}
    {!workId&&<p>{t('Choose a chat to inspect or reconnect its connectors.')}</p>}
    {error&&<p role="alert">{t('Could not check connectors. Try again.')}</p>}
    {status?.state==='busy'&&<p role="status">{t('Wait for this chat to finish before reconnecting.')}</p>}
    {status?.state==='failed'&&<p role="status">{t('Reconnect did not finish. Try again before sending.')}</p>}
    {status?.state==='unavailable'&&<p role="status">{t('Connection status is unavailable. Reconnect to check again.')}</p>}
    {pending&&<p role="status">{t('Reconnecting connectors…')}</p>}
    {status?.items.map(item=><div className="ec-connectorrow" key={item.id}><span dir="auto">{item.id}</span><Badge kind={item.state==='ready'?'good':undefined}>{item.state==='ready'?t('Ready · {count} tools',{count:item.toolCount}):item.state==='disabled'?t('Disabled'):item.state==='needs_attention'?t('Needs attention'):t('Not connected yet')}</Badge></div>)}
    {status?.items.length===0&&<p>{t('No connectors configured.')}</p>}
  </section>;
}
