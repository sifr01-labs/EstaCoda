import {useId,useLayoutEffect,useRef,useState} from 'react';
import {formatRoutingStatus,type ActivityProjection} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {Button,Icon} from './primitives.js';

type Model=Extract<ActivityProjection,{kind:'model'}>;
/** Group display records without dropping attempts or equating calls with answers. */
export function responseModelGroups(items:Model[]){
 const groups=new Map<string,{provider:string;model:string;records:Model[]}>();
 for(const item of items){const model=item.executionModel,key=JSON.stringify([model.providerId,model.modelId]);
  if(!groups.has(key))groups.set(key,{provider:model.providerId,model:model.modelId,records:[]});
  groups.get(key)!.records.push(item);
 }
 return [...groups.values()];
}
export function ResponseDetails({items,active,answered}:{items:ActivityProjection[];active:boolean;answered:boolean}){
 const {t,language}=useI18n();
 const id=useId(),button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const [open,setOpen]=useState(false),reposition=useRef<(()=>void)|undefined>(undefined);
 useLayoutEffect(()=>{
  if(!open)return;
  const element=panel.current!,anchor=button.current!;
  const position=()=>{
   if(!element.matches(':popover-open'))return;
   const rect=anchor.getBoundingClientRect(),viewport=window.visualViewport;
   const left=viewport?.offsetLeft??0,top=viewport?.offsetTop??0,width=viewport?.width??innerWidth,height=viewport?.height??innerHeight;
   if(rect.bottom<top||rect.top>top+height||rect.right<left||rect.left>left+width){element.hidePopover();return;}
   const gap=8,edge=12,above=rect.top-top-gap-edge,below=top+height-rect.bottom-gap-edge;
   const upwards=above>=Math.min(element.scrollHeight,320)||above>=below;
   element.style.width=Math.min(360,width-edge*2)+'px';
   element.style.maxHeight=Math.max(80,Math.min(480,upwards?above:below))+'px';
   const box=element.getBoundingClientRect();
   const start=language==='ar'?rect.right-box.width:rect.left;
   element.style.left=Math.max(left+edge,Math.min(start,left+width-box.width-edge))+'px';
   element.style.top=Math.max(top+edge,Math.min(upwards?rect.top-gap-box.height:rect.bottom+gap,top+height-box.height-edge))+'px';
   element.style.visibility='visible';
  };
  reposition.current=position;position();
  // Position after resize delivery so measuring and clamping cannot re-enter the observer.
  let frame=0;const resize=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(position);});resize.observe(element);resize.observe(anchor);
  // Capture scroll from the conversation pane; the panel itself scrolls independently.
  const scroll=(event:Event)=>{if(!element.contains(event.target as Node))position();};
  window.addEventListener('scroll',scroll,true);window.addEventListener('resize',position);
  window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
  return()=>{reposition.current=undefined;cancelAnimationFrame(frame);resize.disconnect();window.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',position);window.visualViewport?.removeEventListener('resize',position);window.visualViewport?.removeEventListener('scroll',position);};
 },[open,language]);
 const models=items.filter((item):item is Model=>item.kind==='model');
 const routes=items.filter((item):item is Extract<ActivityProjection,{kind:'routing'}>=>item.kind==='routing');
 const latestRoutes=[...new Map(routes.map(item=>[item.routing.stage,item])).values()];
 const model=models.at(-1);
 const priorFailure=models.slice(0,models.findIndex(item=>item.executionModel.fallback)).some(item=>item.executionModel.state==='failed');
 const fullFallback=latestRoutes.some(item=>item.routing.configuredMode==='jev-assisted'&&item.routing.actualEngine==='standard');
 const partial=latestRoutes.some(item=>item.routing.partialFallback);
 const switched=!!model?.executionModel.fallback;
 const completed=answered&&!active&&model?.executionModel.state==='responded';
 if(!models.length&&!routes.length)return null;
 return <><button ref={button} type="button" className="ec-btn ec-ghost ec-iconbutton ec-response-info" aria-label={t('Response details')} title={t('Response details')} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} popoverTarget={id}><Icon name="info"/></button>
 <div ref={panel} id={id} className="ec-response-popover" popover="auto" role="dialog" aria-labelledby={id+'-title'} onBeforeToggle={event=>{if(event.target===event.currentTarget&&event.newState==='open')event.currentTarget.style.visibility='hidden';}} onToggle={event=>{if(event.target!==event.currentTarget)return;const visible=event.newState==='open';setOpen(visible);if(visible)reposition.current?.();}}>
 <header><h2 id={id+'-title'}>{t('Response details')}</h2><Button className="ec-ghost ec-iconbutton" icon="x" aria-label={t('Close')} onClick={()=>{panel.current?.hidePopover();button.current?.focus();}}/></header>
 <div className="ec-response-body"><dl className="ec-response-facts">
 {model&&<div><dt>{t(completed?'Answered by':active?'Current execution model':'Last recorded model')}</dt><dd className="ec-response-modelname"><bdi>{model.executionModel.modelId}</bdi>{switched&&<small>{t('Model switched')}</small>}</dd></div>}
 {switched&&<div><dt>{t('Model change')}</dt><dd>{t(priorFailure?'An earlier model attempt failed. A fallback model was used.':'A fallback model was used.')}</dd></div>}
 {!!latestRoutes.length&&<div><dt>{t('Routing')}</dt><dd>{fullFallback&&<strong>{t('Standard routing used')}<br/></strong>}{t(fullFallback?'Standard handled one or more routing stages.':partial?'Jev-assisted, with Standard resolving uncertain selections.':latestRoutes.some(item=>item.routing.actualEngine==='jev')?'Jev-assisted':'Standard')}</dd></div>}
 </dl><details className="ec-response-technical"><summary>{t('Technical details')}<Icon name="chevron-right"/></summary>
 {responseModelGroups(models).map(group=><details className="ec-response-model" key={JSON.stringify([group.provider,group.model])}><summary><span><bdi>{group.model}</bdi><small><bdi>{group.provider}</bdi></small></span><span>{t('Completed calls: {count}',{count:group.records.filter(item=>item.executionModel.state==='responded').length})} · {t('Failed calls: {count}',{count:group.records.filter(item=>item.executionModel.state==='failed').length})}</span><Icon name="chevron-right"/></summary><ol>{group.records.map(item=><li key={item.id}><span>{t(item.executionModel.state==='responded'?'Call completed':item.executionModel.state==='failed'?'Call failed':'Call started')}</span>{item.timestamp>0&&<time dateTime={new Date(item.timestamp).toISOString()}>{new Date(item.timestamp).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>}</li>)}</ol></details>)}
 {routes.map(item=><p className="ec-response-routing" key={item.id} dir="auto">{formatRoutingStatus(item.routing,language)}</p>)}
 </details></div></div></>;
}
