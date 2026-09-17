import type {ReactNode} from 'react';
import {useI18n} from '../i18n.js';
import {Icon} from './primitives.js';
/** Collection filters describe loaded data, never a global result count. */
export function CollectionFilters({label,options,value,change}:{label:string;options:{id:string;label:string;count?:number}[];value:string;change:(value:string)=>void}){
 return <div className="ec-collection-tabs" role="group" aria-label={label}>{options.map(option=><button type="button" key={option.id} aria-pressed={option.id===value} onClick={()=>change(option.id)}>{option.label}{option.count!==undefined&&<span>{option.count}</span>}</button>)}</div>;
}
export function CollectionEmpty({icon,title,children}:{icon:string;title:string;children:ReactNode}){return <div className="ec-collection-empty"><span className="ec-collection-tile"><Icon name={icon}/></span><h2>{title}</h2><p>{children}</p></div>;}
export function CollectionDate({value}:{value:number|string}){
 const {language}=useI18n();const date=new Date(value);if(!Number.isFinite(date.getTime())||date.getTime()<=0)return null;
 const minutes=Math.round((date.getTime()-Date.now())/60000),relative=new Intl.RelativeTimeFormat(language,{numeric:'auto',style:'short'});
 const label=Math.abs(minutes)<60?relative.format(minutes,'minute'):Math.abs(minutes)<1440?relative.format(Math.round(minutes/60),'hour'):date.toLocaleDateString(language,{month:'short',day:'numeric'});
 return <time dateTime={date.toISOString()} title={date.toLocaleString(language)}>{label}</time>;
}
export function fileSize(bytes:number){return bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`;}
export function fileKind(mime:string){return mime.includes('yaml')?'YAML':mime.includes('json')?'JSON':mime.includes('markdown')?'Markdown':mime.startsWith('image/')?'Image':mime.includes('pdf')?'PDF':mime.startsWith('audio/')?'Audio':mime.startsWith('video/')?'Video':mime.startsWith('text/')?'Text':mime;}
