import {useEffect,useRef,useState} from 'react';
import type {WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import type {ChatMetadata} from '../../shared/chat-presentation.js';
import {useI18n} from '../i18n.js';
import {Button} from './primitives.js';
export function ChatMenu({item,x,y,close,restoreFocus,pinned,togglePin,metadata,update,api}:{item:WorkProjection;x:number;y:number;close:()=>void;restoreFocus:()=>void;pinned:boolean;togglePin:()=>void;metadata:ChatMetadata;update:(value:Partial<ChatMetadata>)=>void;api?:DesktopApi}){
 const {t}=useI18n(),root=useRef<HTMLDivElement>(null);const[rename,setRename]=useState(false),[title,setTitle]=useState(item.title),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const dismiss=()=>{close();restoreFocus();};
 useEffect(()=>{const el=root.current;if(!el)return;const box=el.getBoundingClientRect();el.style.left=Math.max(8,Math.min(x,innerWidth-box.width-8))+'px';el.style.top=Math.max(8,Math.min(y,innerHeight-box.height-8))+'px';el.querySelector<HTMLElement>('input,button')?.focus();const outside=(event:PointerEvent)=>{if(!el.contains(event.target as Node))close();};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[x,y,rename]);
 const act=(run:()=>void|Promise<void>)=>{if(busy)return;setBusy(true);void Promise.resolve().then(run).then(dismiss).catch(()=>{setError(t('Chat action could not complete.'));setBusy(false);});};
 const local=item.id==='welcome'||item.id.startsWith('draft-');
 const copy=async()=>{if(!api?.clipboard)throw new Error('Clipboard unavailable');let page=await api.activity(item.id),count=0;const lines:string[]=[],cursors=new Set<string>();let bytes=0;while(true){for(const entry of page.items){if(++count>2000)throw new Error('Copy limit');if(entry.kind==='message'){bytes+=entry.text.length;if(bytes>1_000_000)throw new Error('Copy limit');lines.push((entry.role==='user'?t('You'):'EstaCoda')+':\n'+entry.text);}}if(!page.nextCursor)break;if(cursors.has(page.nextCursor))throw new Error('Copy limit');cursors.add(page.nextCursor);page=await api.activity(item.id,page.nextCursor);}await api.clipboard.writeText(lines.join('\n\n'));};
 return <div ref={root} className="ec-chatmenu" role={rename?'dialog':'menu'} aria-label={t(rename?'Rename chat':'Chat actions')} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();dismiss();}if(['ArrowDown','ArrowUp','Home','End','Tab'].includes(event.key)){const controls=[...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input')];const index=controls.indexOf(document.activeElement as HTMLElement);event.preventDefault();controls[event.key==='Home'?0:event.key==='End'?controls.length-1:(index+(event.key==='ArrowUp'||event.key==='Tab'&&event.shiftKey?-1:1)+controls.length)%controls.length]?.focus();}}}>
 {rename?<form onSubmit={event=>{event.preventDefault();if(title.trim())act(()=>update({title:title.trim()}));}}><label>{t('Chat name')}<input autoFocus maxLength={160} value={title} onChange={event=>setTitle(event.target.value)} dir="auto"/></label><div className="ec-actions"><Button type="button" onClick={dismiss}>{t('Cancel')}</Button><Button type="submit" disabled={!title.trim()}>{t('Save name')}</Button></div></form>:<>
 <Button role="menuitem" icon="pencil" onClick={()=>setRename(true)}>{t('Rename chat')}</Button>
 {!local&&<Button role="menuitem" icon="pin" disabled={busy} onClick={()=>act(togglePin)}>{pinned?t('Unpin'):t('Pin')}</Button>}
 <Button role="menuitem" icon="eye" disabled={busy} onClick={()=>act(()=>update({unread:true}))}>{t('Mark as unread')}</Button>
 <Button role="menuitem" icon="archive" disabled={busy} onClick={()=>act(()=>update({archived:!metadata.archived}))}>{t(metadata.archived?'Restore chat':'Archive chat')}</Button>
 {!local&&item.target&&api?.chats&&<Button role="menuitem" icon="folder-open" disabled={busy} onClick={()=>act(()=>api.chats!.openFolder(item.id))}>{t('Open workspace folder')}</Button>}
 {!local&&api?.clipboard&&<Button role="menuitem" icon="copy" disabled={busy} onClick={()=>act(copy)}>{t('Copy conversation')}</Button>}
 <Button role="menuitem" icon="hash" disabled={busy||!api?.clipboard} onClick={()=>act(()=>api!.clipboard!.writeText(item.canonicalId))}>{t('Copy chat ID')}</Button>
 </>}{error&&<p role="alert">{error}</p>}</div>;
}
