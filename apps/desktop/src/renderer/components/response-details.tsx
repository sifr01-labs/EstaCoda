import {formatRoutingStatus,type ActivityProjection} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {Icon} from './primitives.js';

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
 return <details className="ec-run-details"><summary><Icon name="cpu"/><span>{t('Response details')}</span>{model&&<bdi>{model.executionModel.modelId}</bdi>}{switched&&<small>{t('Model switched')}</small>}{fullFallback&&<small>{t('Standard routing used')}</small>}<Icon name="chevron-right"/></summary>
 <div className="ec-response-body"><dl className="ec-response-facts">
 {model&&<div><dt>{t(completed?'Answered by':active?'Current execution model':'Last recorded model')}</dt><dd><bdi>{model.executionModel.modelId}</bdi></dd></div>}
 {switched&&<div><dt>{t('Model change')}</dt><dd>{t(priorFailure?'An earlier model attempt failed. A fallback model was used.':'A fallback model was used.')}</dd></div>}
 {!!latestRoutes.length&&<div><dt>{t('Routing')}</dt><dd>{t(fullFallback?'Standard handled one or more routing stages.':partial?'Jev-assisted, with Standard resolving uncertain selections.':latestRoutes.some(item=>item.routing.actualEngine==='jev')?'Jev-assisted':'Standard')}</dd></div>}
 </dl><details className="ec-response-technical"><summary>{t('Technical details')}<Icon name="chevron-right"/></summary>
 {responseModelGroups(models).map(group=><details className="ec-response-model" key={JSON.stringify([group.provider,group.model])}><summary><span><bdi>{group.model}</bdi><small><bdi>{group.provider}</bdi></small></span><span>{t('Completed calls: {count}',{count:group.records.filter(item=>item.executionModel.state==='responded').length})} · {t('Failed calls: {count}',{count:group.records.filter(item=>item.executionModel.state==='failed').length})}</span><Icon name="chevron-right"/></summary><ol>{group.records.map(item=><li key={item.id}><span>{t(item.executionModel.state==='responded'?'Call completed':item.executionModel.state==='failed'?'Call failed':'Call started')}</span>{item.timestamp>0&&<time dateTime={new Date(item.timestamp).toISOString()}>{new Date(item.timestamp).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>}</li>)}</ol></details>)}
 {routes.map(item=><p className="ec-response-routing" key={item.id} dir="auto">{formatRoutingStatus(item.routing,language)}</p>)}
 </details></div></details>;
}
