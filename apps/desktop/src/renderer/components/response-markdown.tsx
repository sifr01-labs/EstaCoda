import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {useState,type ReactNode} from 'react';
import {useI18n} from '../i18n.js';
import {Button} from './primitives.js';
function textOf(value:ReactNode):string{
 if(typeof value==='string'||typeof value==='number')return String(value);
 if(Array.isArray(value))return value.map(textOf).join('');
 if(value&&typeof value==='object'&&'props' in value)return textOf((value.props as {children?:ReactNode}).children);
 return '';
}
function Copy({value,children}:{value:string;children?:ReactNode}){
 const {t}=useI18n();const[state,setState]=useState<'idle'|'copied'|'failed'>('idle');
 return <Button className="ec-ghost ec-copy" title={value.length<2048&&children?value:undefined} aria-label={children?t('Copy link'):t('Copy code')} onClick={()=>{void navigator.clipboard.writeText(value).then(()=>setState('copied'),()=>setState('failed'));}}>{state==='copied'?t('Copied'):state==='failed'?t('Copy unavailable'):children??t('Copy code')}</Button>;
}
/** No HTML, remote images, embedded media, or automatic navigation from provider content. */
export function ResponseMarkdown({text}:{text:string}){
 return <div className="ec-markdown" dir="auto"><Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']} urlTransform={url=>/^https?:\/\//i.test(url)?url:''} components={{
  pre:({children})=><div className="ec-codeblock"><div className="ec-codebar"><Copy value={textOf(children)}/></div><pre dir="ltr">{children}</pre></div>,
  a:({href,children})=>href?<Copy value={href}>{children}</Copy>:<span>{children}</span>,
  table:({children})=><div className="ec-tablewrap"><table>{children}</table></div>
 }}>{text}</Markdown></div>;
}
