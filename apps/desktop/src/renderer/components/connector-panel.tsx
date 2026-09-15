import {useEffect, useRef, useState} from 'react';
import type {ConnectorStatus} from '@estacoda/control-protocol';
import type {DesktopConnectionsApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {Badge, Button} from './primitives.js';

export function ConnectorPanel({api, workId, close, compact=false}: {compact?:boolean;api: Pick<DesktopConnectionsApi, 'connectors'>; workId?: string; close?: () => void}) {
  const {t} = useI18n();
  const [status, setStatus] = useState<ConnectorStatus>();
  const [manage,setManage]=useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const generation = useRef(0), sequence = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setStatus(undefined); setError(false); setBusy(false);
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
    if(busy || !workId)return;
    const current = generation.current, request=++sequence.current; setBusy(true); setError(false);
    try { const next = await api.connectors({action:'reconnect',workId}); if(current===generation.current&&request===sequence.current)setStatus(next); }
    catch { if(current===generation.current&&request===sequence.current)setError(true); }
    finally { if(current===generation.current)setBusy(false); }
  };
  const pending = busy || status?.state==='reconnecting';
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
