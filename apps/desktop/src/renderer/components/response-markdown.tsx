import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useI18n} from '../i18n.js';
import {Button} from './primitives.js';
function textOf(value:ReactNode):string{
 if(typeof value==='string'||typeof value==='number')return String(value);
 if(Array.isArray(value))return value.map(textOf).join('');
 if(value&&typeof value==='object'&&'props' in value)return textOf((value.props as {children?:ReactNode}).children);
 return '';
}
function Copy({value,children}:{value:string;children?:ReactNode}){
 const {t}=useI18n(),[state,setState]=useState<'idle'|'copied'|'failed'>('idle'),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 async function copy(){
  clearTimeout(timer.current);
  try{if(window.desktop?.clipboard)await window.desktop.clipboard.writeText(value);else await navigator.clipboard.writeText(value);setState('copied');}
  catch{setState('failed');}
  timer.current=setTimeout(()=>setState('idle'),2000);
 }
 const label=children?t('Copy link'):t('Copy code'),feedback=state==='copied'?t('Copied'):state==='failed'?t('Copy unavailable'):'';
 return <><Button className={'ec-ghost ec-copy'+(children?'':' ec-iconbutton')} icon={children?undefined:state==='copied'?'check':'copy'} title={feedback||(children&&value.length<2048?value:label)} aria-label={label} onClick={()=>void copy()}>{children}</Button><span className={state==='failed'?'ec-copy-error':'ec-sr-only'} role="status">{feedback}</span></>;
}
/** No HTML, remote images, embedded media, or automatic navigation from provider content. */
export function ResponseMarkdown({text}:{text:string}){
 return <div className="ec-markdown" dir="auto"><Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']} urlTransform={url=>/^https?:\/\//i.test(url)?url:''} components={{
  pre:({children})=><div className="ec-codeblock"><div className="ec-codebar"><Copy value={textOf(children)}/></div><pre dir="ltr">{children}</pre></div>,
  a:({href,children})=>href?<Copy value={href}>{children}</Copy>:<span>{children}</span>,
  table:({children})=><div className="ec-tablewrap"><table>{children}</table></div>
 }}>{text}</Markdown></div>;
}
