import {useEffect,useRef,useState} from 'react';
import {useI18n} from '../i18n.js';
import {Button} from './primitives.js';
export function MessageActions({text,timestamp}:{text:string;timestamp:number}){
 const {t,language}=useI18n(),[state,setState]=useState<'idle'|'copied'|'failed'>('idle'),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 async function copy(){try{if(window.desktop?.clipboard)await window.desktop.clipboard.writeText(text);else await navigator.clipboard.writeText(text);setState('copied');}catch{setState('failed');}clearTimeout(timer.current);timer.current=setTimeout(()=>setState('idle'),1800);}
 return <div className="ec-message-actions"><Button className="ec-ghost ec-iconbutton" icon={state==='copied'?'check':'copy'} aria-label={t('Copy message')} title={t('Copy message')} onClick={()=>void copy()}/>{timestamp>0&&<time dateTime={new Date(timestamp).toISOString()} title={new Date(timestamp).toLocaleString(language)}>{new Date(timestamp).toLocaleTimeString(language,{hour:'numeric',minute:'2-digit'})}</time>}<span role="status">{state==='copied'?t('Copied'):state==='failed'?t('Could not copy. Try again.'):''}</span></div>;
}
