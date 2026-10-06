import {useEffect,useRef,useState,type ReactNode} from 'react';
import {formatRoutingCheck} from '@estacoda/control-protocol';
import type {DesktopSettingsApi} from '../../shared/desktop-api.js';
import type {SettingsPage,SettingValue} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {Button,Icon} from './primitives.js';
import {CapabilityCard} from './capability-card.js';
import {ProviderMark} from './provider-mark.js';

type Props={api:DesktopSettingsApi;dirty:boolean;page:SettingsPage;disabled:boolean;value:(id:string)=>SettingValue;change:(id:string,value:SettingValue)=>void;control:(id:string,label?:string)=>ReactNode;onEditing:(editing:boolean)=>void};
/** Uses the existing model cards, protected credential control and parent review/apply. */
export function RoutingSettings({api,dirty,page,disabled,value,change,control,onEditing}:Props){
 const {t,language}=useI18n();
 const [checking,setChecking]=useState(false),[check,setCheck]=useState<Awaited<ReturnType<DesktopSettingsApi['verify']>>['routing']>();
 const checkEpoch=useRef(0);
 useEffect(()=>{checkEpoch.current++;setCheck(undefined);return()=>{checkEpoch.current++;};},[page,dirty]);
 async function checkConnection(){const epoch=++checkEpoch.current;setChecking(true);setCheck(undefined);try{const result=await api.verify({routing:true,spendApproved:true});if(epoch===checkEpoch.current)setCheck(result.routing??{state:'failed',reason:'service-error'});}catch{if(epoch===checkEpoch.current)setCheck({state:'failed',reason:'service-error'});}finally{setChecking(false);}}

 const [view,setView]=useState<'providers'|'models'|'model'>(),[query,setQuery]=useState('');
 const [selected,setSelected]=useState('');
 const heading=useRef<HTMLHeadingElement>(null),opener=useRef<HTMLButtonElement>(null);
 const jev=value('routing.mode')==='jev-assisted',models=page.runtime?.routingModels??[];
 useEffect(()=>{onEditing(!!view);heading.current?.focus();return()=>onEditing(false);},[view]);
 function home(){setView(undefined);setQuery('');requestAnimationFrame(()=>opener.current?.focus());}
 const modelLabel=models.find(m=>m.id===value('routing.jev.id'))?.label??String(value('routing.jev.id')??'');
 if(view)return <section aria-label={t('Routing model')}>
  <Button className="ec-ghost ec-model-back" icon="arrow-left" disabled={disabled} onClick={home}>{t('Back')}</Button>
  <h2 className="ec-media-picker-title" ref={heading} tabIndex={-1}>{t(view==='providers'?'Choose a provider':view==='models'?'Choose a model':'Routing model')}</h2>
  {view!=='model'&&<label className="ec-model-search"><Icon name="search"/><input type="search" aria-label={t('Search providers and models')} placeholder={t('Search providers or models')} value={query} onChange={e=>setQuery(e.target.value)}/></label>}
  {view==='providers'&&'typesafe jev'.includes(query.toLowerCase())&&<button className="ec-model-choice" disabled={disabled} onClick={()=>{setQuery('');setView('models');}}><ProviderMark id="typesafe" label={t('TypeSafe')}/><span className="ec-model-grow"><strong>{t('TypeSafe')}</strong><span>{t('Intent, skill, and capability selection')}</span></span><Icon name="chevron-right"/></button>}
  {view==='models'&&models.filter(m=>(m.label+' '+m.id).toLowerCase().includes(query.toLowerCase())).map(m=><button className="ec-model-choice" disabled={disabled} key={m.id} onClick={()=>{setSelected(m.id);setView('model');}}><ProviderMark id="typesafe" label={t('TypeSafe')}/><span className="ec-model-grow"><strong><bdi>{m.label}</bdi></strong><span>{t('TypeSafe')} · <bdi>{m.id}</bdi></span></span><Icon name="chevron-right"/></button>)}
  {view==='model'&&<><CapabilityCard icon={<ProviderMark id="typesafe" label={t('TypeSafe')}/>} title={<bdi>{models.find(m=>m.id===selected)?.label??selected}</bdi>} description={t('TypeSafe')}/>
   <section className="ec-media-section">{control('routing.jev.apiKeyEnv',t('API key'))}</section>
   <p className="ec-footnote">{t('Jev receives relevant request context and capability descriptions. Your conversation model stays the same.')}</p>
   <div className="ec-model-footeractions"><Button disabled={disabled} onClick={()=>setView('models')}>{t('Back')}</Button><Button className="ec-primary" disabled={disabled} onClick={()=>{change('routing.jev.provider','typesafe');change('routing.jev.id',selected);home();}}>{t('Use this model')}</Button></div>
  </>}
 </section>;
 return <section className="ec-media-section" aria-label={t('Intent & capability routing')}>
  <h2>{t('Intent & capability routing')}</h2>
  <div className="ec-media-row"><div>{t('Routing mode')}</div><select aria-label={t('Routing mode')} value={String(value('routing.mode')??'standard')} disabled={disabled} onChange={e=>change('routing.mode',e.target.value)}><option value="standard">{t('Standard')}</option><option value="jev-assisted">{t('Jev-assisted')}</option></select></div>
  {jev&&<><CapabilityCard icon={<ProviderMark id="typesafe" label={t('TypeSafe')}/>} title={<bdi>{modelLabel}</bdi>} description={t('TypeSafe')} action={<Button disabled={disabled} onClick={()=>{opener.current=document.activeElement as HTMLButtonElement;setView('providers');}}>{t('Change')}</Button>}/><details className="ec-diagnostics"><summary>{t('Advanced')}</summary>{control('routing.jev.timeoutMs',t('Routing timeout (milliseconds)'))}</details></>}
  <p className="ec-footnote">{t('Jev receives relevant request context and capability descriptions. Your conversation model stays the same.')}</p>
  <p className="ec-footnote">{t('Saved routing changes apply at the next routing decision. Work already executing keeps its permissions.')}</p>
  {jev&&<div><p className="ec-footnote">{t('Check saved settings with a small test sent to TypeSafe. Charges may apply. Save changes before checking.')}</p><Button disabled={disabled||dirty||checking} onClick={()=>void checkConnection()}>{t(checking?'Checking connection…':'Check saved connection')}</Button>{check&&<p role="status" className="ec-footnote">{formatRoutingCheck(check,language)}</p>}</div>}
  <p className="ec-footnote" role="status">{t('Jev-assisted mode selects intents, skills, and capabilities. Execution permissions stay the same.')}</p>
 </section>;
}
