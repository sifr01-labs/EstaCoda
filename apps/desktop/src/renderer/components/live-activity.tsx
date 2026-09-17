import {BrandEye} from './primitives.js';
import {ResponseMarkdown} from './response-markdown.js';
import {CanonicalActivity} from './canonical-activity.js';
import {useI18n} from '../i18n.js';
import {useEffect,useRef,useState} from 'react';
import type {ActivityProjection,MethodContracts,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi,DesktopWorkApi} from '../../shared/desktop-api.js';
type Preview=MethodContracts['work.live']['result'];
export type LiveSegment={key:string;turnId:string|null;text:string;truncated:boolean};
export function appendPreview(segments:LiveSegment[],preview:Preview):LiveSegment[]{
 if(!preview.text)return segments;
 const last=segments.at(-1);
 if(last?.turnId===preview.turnId&&preview.text.startsWith(last.text))return [...segments.slice(0,-1),{...last,text:preview.text,truncated:preview.truncated}];
 if(last?.turnId===preview.turnId&&last.text===preview.text)return segments;
 return [...segments,{key:crypto.randomUUID(),turnId:preview.turnId,text:preview.text,truncated:preview.truncated}].slice(-32);
}
/** One in-flight read, coalesced at 4Hz while active. No simulated typing or delayed final text. */
export function LiveActivity({api,work,items=[],waiting=false,results=()=>{},browser,desktopApi,more}:{api:DesktopWorkApi;work:WorkProjection;items?:ActivityProjection[];waiting?:boolean;results?:()=>void;browser?:()=>void;desktopApi?:DesktopApi;more?:boolean}){
 const {t}=useI18n();const[preview,setPreview]=useState<Preview|null>(null),[segments,setSegments]=useState<LiveSegment[]>([]);
 const baseline=useRef(new Set(items.filter(item=>item.kind==='message').map(item=>item.id)));
 // Existing history may arrive after mounting; only start a segment when a live turn exists.
 const currentItems=useRef(items);currentItems.current=items;const tracking=useRef(false);
 useEffect(()=>{if(work.kind!=='session'||!work.target||!api.live)return;let active=true,timer:ReturnType<typeof setTimeout>;
 const poll=async()=>{let delay=1000;try{const next=await api.live(work.id);if(!active)return;
 if(next.active){delay=250;if(!tracking.current){baseline.current=new Set(currentItems.current.filter(item=>item.kind==='message').map(item=>item.id));tracking.current=true;}}
 setPreview(next);if(tracking.current)setSegments(previous=>appendPreview(previous,next));
 }catch{/* Preserve readable preview through a transient read failure. */}finally{if(active)timer=setTimeout(()=>void poll(),delay);}};
 void poll();return()=>{active=false;clearTimeout(timer);};},[api,work.id,work.target?.targetGeneration]);
 const committed=items.filter((item):item is Extract<ActivityProjection,{kind:'message'}>=>item.kind==='message'&&item.role==='assistant'&&!baseline.current.has(item.id));
 const pending=segments.filter(segment=>!committed.some(item=>item.text.trim().startsWith(segment.text.trim())));
 const running=preview?.active&&work.status==='running'&&!waiting;
 return <><CanonicalActivity items={items} results={results} browser={browser} api={desktopApi} workStatus={waiting?'needs_attention':work.status} more={more}/>{pending.map(segment=><section className="ec-agent ec-live-response" aria-label={t('Live assistant activity')} key={segment.key}><ResponseMarkdown text={segment.text}/>{segment.truncated&&<p className="ec-footnote">{t('Live preview limit reached. The settled response will appear in activity.')}</p>}</section>)}{running&&<div className="ec-live-working" role="status"><span className="ec-working-presence" aria-hidden="true"><BrandEye/></span><span className="ec-working-word">{t('Working')}</span></div>}</>;
}
