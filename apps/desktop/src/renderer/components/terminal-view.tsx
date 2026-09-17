import {WorkspacePanel} from './workspace-panel.js';
import {Icon} from './primitives.js';
import {useI18n} from '../i18n.js';
import {useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type {TargetReference} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {Button} from './primitives.js';
export function TerminalView({api,target,close,hidden=false}:{hidden?:boolean;api:DesktopApi;target:TargetReference;close:()=>void}){
 const {t,owned}=useI18n();
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const host=useRef<HTMLDivElement>(null),id=useRef<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[backend,setBackend]=useState(''),[opened,setOpened]=useState(false);
 const stop=async()=>{setBusy(true);try{if(id.current)await api.terminal!.close(id.current);id.current=null;close();}catch{setError('Terminal shutdown could not be confirmed. Retry closing.');setBusy(false);}};
 useEffect(()=>{
  if(!opened||!host.current||!id.current)return;
  let current=true;const terminalId=id.current,style=getComputedStyle(host.current),term=new Terminal({allowProposedApi:false,allowTransparency:false,scrollback:1000,screenReaderMode:true,disableStdin:false,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:12,theme:{background:style.getPropertyValue('--ec-terminal-bg').trim()||'#131313',foreground:'#eeedf0'}}),fit=new FitAddon();term.loadAddon(fit);term.open(host.current);fit.fit();term.focus();
  // No link/clipboard addons. Consume OSC clipboard and hyperlink sequences.
  const clipboard=term.parser.registerOscHandler(52,()=>true),hyperlinks=term.parser.registerOscHandler(8,()=>true);
  let queued=Promise.resolve(),queuedBytes=0;
  const data=term.onData(value=>{
   if(!current||queuedBytes+value.length>16384){setError('Terminal input queue full.');return;}
   queuedBytes+=value.length;
   queued=queued.then(async()=>{for(let offset=0;offset<value.length&&current;offset+=4096)await api.terminal!.write(terminalId,value.slice(offset,offset+4096));}).catch(()=>{if(current){term.options.disableStdin=true;setError('Terminal input unavailable.');}}).finally(()=>{queuedBytes-=value.length;});
  });
  const resize=()=>{if(!current)return;fit.fit();void api.terminal!.resize(terminalId,Math.min(400,Math.max(2,term.cols)),Math.min(200,Math.max(2,term.rows))).catch(()=>{});};const observer=new ResizeObserver(resize);observer.observe(host.current);resize();
  let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const value=await api.terminal!.read(terminalId);if(!current)return;if(value.truncated)term.write(t("[Earlier output truncated]"));await new Promise<void>(resolve=>term.write(value.data,resolve));if(value.state==='stopping'){term.options.disableStdin=true;setError('Waiting for terminal shutdown…');}if(value.state==='closed'){term.options.disableStdin=true;setError('Terminal closed.');if(!value.more)return;}}catch{if(current){term.options.disableStdin=true;term.clear();setError('Terminal disconnected.');}return;}if(current)timer=setTimeout(()=>void poll(),80);};void poll();
  const unsubscribe=api.onSnapshot(snapshot=>{if(snapshot.status!=='ready'&&current){term.options.disableStdin=true;term.reset();setError('Terminal disconnected.');}});
  return()=>{current=false;clearTimeout(timer);unsubscribe();observer.disconnect();data.dispose();clipboard.dispose();hyperlinks.dispose();term.dispose();void api.terminal!.close(terminalId).catch(()=>{});};
 },[api,opened,target.targetId,target.targetGeneration]);
 const open=async()=>{setBusy(true);setError('');try{const result=await api.terminal!.open(target);if(!alive.current){await api.terminal!.close(result.id);return;}id.current=result.id;setBackend(result.backend==='host'?t("Local host · Not sandboxed"):t("Docker · Selected workspace"));setOpened(true);}catch{setError('Terminal was cancelled or its target is unavailable.');}finally{setBusy(false);}};
 return <WorkspacePanel title={t('Terminal')} closeLabel={t('Close terminal')} close={()=>void stop()} busy={busy} hidden={hidden} className="ec-terminal-panel">
 {!opened?<div className="ec-terminal-welcome"><span className="ec-collection-tile"><Icon name="terminal"/></span><h2>{t('A shell in your workspace')}</h2><p>{t('Open a shell in this workspace. The app will ask you to confirm.')}</p><Button className="ec-primary" icon="terminal" disabled={busy} onClick={()=>void open()}>{busy?t('Opening terminal…'):t('Open terminal')}</Button></div>:<><p className="ec-footnote">{backend}</p><div className="ec-terminal" ref={host} dir="ltr"/></>}
 {error&&<p role="status">{owned(error)}</p>}<p className="ec-footnote">{t('Switch panels to keep this terminal open. Closing it ends the session.')}</p><p className="ec-footnote">{t('Ephemeral terminal · Output is not saved to Work · Input does not approve agent actions')}</p></WorkspacePanel>;
}
