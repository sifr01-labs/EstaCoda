import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {useI18n} from '../i18n.js';
import type {Draft} from '../app.js';
import {Button,Icon} from './primitives.js';

type LiveInput={attachEnabled?:boolean;mediaEnabled?:boolean;enabled:boolean;busy:boolean;send:()=>void;attach:(workspace?:boolean)=>void;drop?:(files:File[])=>void;connections?:()=>void;hint:string};
export function Composer({draft,change,fixture,inspect,models,modelControl,live,voice,permissions,stop,sendLabel,queue=false,working=false}:{voice?:ReactNode;permissions?:ReactNode;stop?:ReactNode;queue?:boolean;working?:boolean;sendLabel?:string;live?:LiveInput;modelControl?:ReactNode;draft:Draft;change:(draft:Draft)=>void;fixture:boolean;inspect:()=>void;models:()=>void}){
 const {t}=useI18n();
 const dock=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null),fileInput=useRef<HTMLInputElement>(null),attach=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const restoreInput=useRef(false),dragDepth=useRef(0);
 const [menu,setMenu]=useState(false),[dragging,setDragging]=useState(false),[selected,setSelected]=useState(0),[dismissed,setDismissed]=useState(false),[error,setError]=useState('');
 const disabled=!fixture&&(!live||live.busy),canAttach=fixture||!!live?.enabled&&!live.busy&&live.attachEnabled!==false;
 const commands=[
  ...(live?.mediaEnabled!==false?[{id:'image',icon:'image',label:t('Create an image'),detail:t('Start with a description'),slash:'/image'},{id:'speech',icon:'audio-lines',label:t('Generate speech'),detail:t('Turn text into spoken audio'),slash:'/speech'}]:[]),
  ...(modelControl||fixture?[{id:'model',icon:'box',label:t('Choose a model'),detail:t('For your next message'),slash:'/model'}]:[]),
  ...(permissions||fixture?[{id:'permissions',icon:'shield-check',label:t('Review permissions'),detail:t('Choose how approvals work'),slash:'/permissions'}]:[]),
  ...(live?.connections?[{id:'connections',icon:'plug',label:t('Connections'),detail:t('See tools available in this chat'),slash:'/connections'}]:[]),
 ];
 const query=draft.text.match(/^\/([^\s]*)$/)?.[1];
 const filtered=query===undefined?[]:commands.filter(c=>(c.slash+' '+c.label).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 const commandOpen=!dismissed&&!menu&&!disabled&&query!==undefined;
 const selection=Math.min(selected,Math.max(0,filtered.length-1));
 const closeMenu=()=>{setMenu(false);attach.current?.focus();};
 const resize=()=>{const input=textarea.current;if(!input)return;const before=input.getBoundingClientRect().height;input.style.transition='none';input.style.height='auto';const ceiling=Math.min(260,Math.max(100,window.innerHeight*.3)),content=input.scrollHeight;input.style.height=before+'px';void input.offsetHeight;input.style.transition='';input.style.height=Math.min(ceiling,Math.max(44,content))+'px';input.style.overflowY=content>ceiling?'auto':'hidden';};
 useLayoutEffect(resize,[draft.text]);
 useEffect(()=>{let width=0,frame=0;const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(resize);};const observer=new ResizeObserver(entries=>{const next=entries[0]?.contentRect.width;if(next!==width){width=next??0;schedule();}});if(textarea.current)observer.observe(textarea.current);window.addEventListener('resize',schedule);return()=>{cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',schedule);};},[]);
 useEffect(()=>{if(!live?.busy&&restoreInput.current){if(document.activeElement===document.body)textarea.current?.focus();restoreInput.current=false;}},[live?.busy]);
 useEffect(()=>{if(menu)panel.current?.querySelector<HTMLButtonElement>('.ec-composer-menurow:not(:disabled)')?.focus();},[menu]);
 useEffect(()=>{const outside=(event:PointerEvent)=>{if(!dock.current?.contains(event.target as Node)){setMenu(false);setDismissed(true);}};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[]);
 useEffect(()=>{const input=fileInput.current;const cancel=()=>closeMenu();input?.addEventListener('cancel',cancel);return()=>input?.removeEventListener('cancel',cancel);},[]);
 const choose=(id:string)=>{
  setMenu(false);setDismissed(true);const text=query!==undefined?'':draft.text;
  if(id==='image'||id==='speech'){change({...draft,text,intent:id});textarea.current?.focus();return;}
  if(query!==undefined)change({...draft,text});
  if(id==='model'){const button=dock.current?.querySelector<HTMLButtonElement>('.ec-modelcontrol');if(button)button.click();else models();}
  if(id==='permissions'){const summary=dock.current?.querySelector<HTMLElement>('.ec-permissions summary');if(summary){summary.click();summary.focus();}else inspect();}
  if(id==='connections')live?.connections?.();
 };
 const add=(files:File[])=>{
  setDragging(false);dragDepth.current=0;if(!canAttach)return;
  if(files.length+draft.attachments.length>4){setError(t('Attach up to four files. Remove an attachment first.'));return;}
  setError('');setMenu(false);if(live){live.drop?.(files);return;}
  change({...draft,attachments:[...draft.attachments,...files.map(file=>({name:file.name.slice(0,255),type:file.type,size:file.size}))]});textarea.current?.focus();
 };
 const save=()=>{if(commandOpen&&filtered.length){choose(filtered[selection]!.id);return;}if(live){if(live.enabled&&!live.busy&&(draft.text.trim()||draft.attachments.length)){restoreInput.current=true;live.send();}return;}if(!fixture||!draft.text.trim())return;change({...draft,note:draft.text.trim(),text:'',intent:undefined});textarea.current?.focus();};
 const commandKey=(event:React.KeyboardEvent)=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setMenu(false);setDismissed(true);textarea.current?.focus();return;}
  if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;
  if(commandOpen&&filtered.length&&['ArrowDown','ArrowUp','Enter','Tab'].includes(event.key)){
   event.preventDefault();if(event.key==='Enter'||event.key==='Tab')choose(filtered[selection]!.id);else setSelected((selection+(event.key==='ArrowDown'?1:-1)+filtered.length)%filtered.length);return;
  }
  if(event.key==='Enter'&&!event.shiftKey&&!event.repeat&&(live||event.metaKey||event.ctrlKey)){event.preventDefault();save();}
 };
 return <div ref={dock} className="ec-composerdock ec-refined-composer">
  {stop&&<div className="ec-composer-runline"><span><i/>{t(working?'Working on your request':'Request pending')}</span>{stop}</div>}
  <div className={'ec-composer'+(dragging?' ec-composer-dragging':'')} onDragEnter={event=>{if(!event.dataTransfer.types.includes('Files'))return;event.preventDefault();if(canAttach){dragDepth.current++;setDragging(true);setMenu(false);setDismissed(true);}}} onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=canAttach?'copy':'none';}}} onDragLeave={event=>{event.preventDefault();dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setDragging(false);}} onDrop={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();add(Array.from(event.dataTransfer.files));}}}>
   {error&&<p className="ec-composer-inlineerror" role="alert">{error}</p>}
   {draft.attachments.length>0&&<div className="ec-attachmentlist" aria-label={t('Attachments')}>{draft.attachments.map((file,index)=><div className="ec-attachment" key={file.id??index}>
    <div className="ec-attachment-thumb">{file.thumbnail?.startsWith('data:image/png;base64,')?<img src={file.thumbnail} alt=""/>:<Icon name={file.type.startsWith('image/')?'image':file.type.startsWith('audio/')?'audio-lines':'file-text'}/>}</div>
    <span dir="auto"><b>{file.name}</b><small>{file.type.startsWith('image/')?t('Image'):file.type.startsWith('audio/')?t('Audio'):file.name.split('.').pop()?.toUpperCase()} · {file.size>=1048576?(file.size/1048576).toFixed(1)+' MB':Math.max(1,Math.ceil(file.size/1024))+' KB'}</small></span>
    <Button className="ec-ghost ec-iconbutton ec-remove-attachment" icon="x" aria-label={t('Remove')+' '+file.name} disabled={live?.busy} onClick={()=>{setError('');change({...draft,attachments:draft.attachments.filter((_,i)=>i!==index)});attach.current?.focus();}}/>
   </div>)}</div>}
   {menu&&<div ref={panel} className="ec-composer-popover ec-composer-add" role="group" aria-label={t('Add attachments')} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeMenu();}else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const choices=[...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=choices.indexOf(document.activeElement as HTMLButtonElement);choices[(index+(event.key==='ArrowDown'?1:choices.length-1)+choices.length)%choices.length]?.focus();}}}>
    <div className="ec-composer-menuheading">{t('Add to your message')}<Button icon="x" className="ec-ghost ec-iconbutton" aria-label={t('Close')} onClick={closeMenu}/></div>
    <Button className="ec-composer-menurow" icon="paperclip" aria-label={t('Choose files…')} disabled={!canAttach} onClick={()=>{if(live){live.attach();closeMenu();}else fileInput.current?.click();}}><span><b>{t('Photos & files')}</b><small>{t('Choose from your computer')}</small></span></Button>
    {live&&<Button className="ec-composer-menurow" icon="folder-open" disabled={!canAttach} onClick={()=>{live.attach(true);closeMenu();}}><span><b>{t('Workspace files')}</b><small>{draft.targetLabel??t('From this workspace')}</small></span><Icon name="chevron-right"/></Button>}
    {live?.mediaEnabled!==false&&<><div className="ec-composer-menusection">{t('Create')}</div><Button className="ec-composer-menurow" icon="image" disabled={disabled} onClick={()=>choose('image')}><span><b>{t('Image')}</b><small>{t('Describe what you want to create')}</small></span><Icon name="chevron-right"/></Button><Button className="ec-composer-menurow" icon="audio-lines" disabled={disabled} onClick={()=>choose('speech')}><span><b>{t('Speech')}</b><small>{t('Turn your words into audio')}</small></span><Icon name="chevron-right"/></Button></>}
    {fixture&&<Button className="ec-ghost" onClick={()=>{change({...draft,attachments:[...draft.attachments,{name:'retry-notes.md',type:'text/markdown',size:2048}].slice(0,4)});closeMenu();}}>{t('Try a sample')}</Button>}
   </div>}
   {commandOpen&&<div className="ec-composer-popover ec-composer-commands"><div className="ec-composer-menuheading">{t('Commands for this chat')}<small>{t('Enter to choose')}</small></div><div role="listbox" id="ec-composer-commands" aria-label={t('Commands for this chat')}>{filtered.map((command,index)=><button type="button" role="option" id={'ec-command-'+command.id} aria-selected={index===selection} className="ec-composer-command" key={command.id} onClick={()=>choose(command.id)}><Icon name={command.icon}/><span><b>{command.label}</b><small>{command.detail}</small></span><code dir="ltr">{command.slash}</code></button>)}{!filtered.length&&<p className="ec-composer-menuheading">{t('No matching commands')}</p>}</div><div className="ec-composer-palettefoot">{t('↑ ↓ Navigate · Esc Close')}</div></div>}
   <input ref={fileInput} type="file" multiple hidden aria-label={t('Choose attachments')} onChange={event=>{add(Array.from(event.target.files??[]));event.target.value='';}}/>
   {draft.intent&&<div className="ec-composer-intent"><Icon name={draft.intent==='image'?'image':'audio-lines'}/>{t(draft.intent==='image'?'Create image':'Generate speech')}<Button icon="x" className="ec-ghost ec-iconbutton" aria-label={t('Remove creation mode')} disabled={disabled} onClick={()=>change({...draft,intent:undefined})}/></div>}
   <textarea ref={textarea} id="ec-guidance" aria-label={t('Draft guidance')} aria-controls={commandOpen?'ec-composer-commands':undefined} aria-activedescendant={commandOpen&&filtered[selection]?'ec-command-'+filtered[selection]!.id:undefined} dir="auto" rows={1} placeholder={t(draft.intent==='image'?'Describe the image you have in mind…':draft.intent==='speech'?'What would you like to hear?':'What should we do next?')} value={draft.text} disabled={disabled} maxLength={32768} onChange={event=>{setDismissed(false);setSelected(0);setMenu(false);change({...draft,text:event.target.value});}} onKeyDown={commandKey}/>
   <div className="ec-composerfoot"><div className="ec-composercontrols"><button ref={attach} type="button" className="ec-btn ec-ghost ec-iconbutton" aria-label={t('Add attachments')} aria-expanded={menu} disabled={!canAttach} onClick={()=>{setDismissed(true);setMenu(value=>!value);}}><Icon name="plus"/></button>{permissions}{fixture&&<Button className="ec-ghost" icon="shield-check" onClick={inspect}>{t('Strict')}</Button>}</div><div className="ec-composerright">{modelControl??<Button className="ec-ghost ec-modelcontrol" onClick={models} disabled={!fixture}>{fixture?draft.model:t('Model unavailable')}<Icon name="chevron-down"/></Button>}{voice}<Button className={'ec-primary ec-send'+(queue?' ec-send-queue':'')} icon={queue?'list-plus':'arrow-up'} title={t('Enter to send · Shift+Enter for a new line')} aria-label={sendLabel??t(fixture?'Save draft guidance':'Send prompt')} disabled={!fixture&&(!live?.enabled||live.busy||(!draft.text.trim()&&!draft.attachments.length))} onClick={save}>{queue?t('Queue'):null}</Button></div></div>
   {dragging&&<div className="ec-composer-drop" role="status"><Icon name="paperclip"/><span><b>{t('Drop into your message')}</b><small>{t('Photos and files · review before sending')}</small></span></div>}
  </div>
  {(fixture||live?.hint)&&<p className="ec-composer-hints">{fixture?t('Draft for this Work · simulated interactions'):live?.hint}</p>}
 </div>;
}
