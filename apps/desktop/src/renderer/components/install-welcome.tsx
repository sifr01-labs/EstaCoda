import {useEffect,useRef,useState} from 'react';
import type {DesktopApi,DesktopSnapshot} from '../../shared/desktop-api.js';
import type {MethodContracts} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {LanguageSelect} from './language-select.js';
import {BrandEye,Button} from './primitives.js';
import {LoadingStatus} from './loading.js';

export function InstallWelcome({api,snapshot,complete,repair}:{api:DesktopApi;snapshot:DesktopSnapshot;complete:(mode:'fresh'|'existing')=>void;repair:()=>void}){
 const {t,status}=useI18n(),[mode,setMode]=useState<'fresh'|'existing'>(),[inspection,setInspection]=useState<MethodContracts['setup.local']['result']>(),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const [profiles,setProfiles]=useState<{id:string;label:string}[]>([]),[name,setName]=useState(''),[review,setReview]=useState<MethodContracts['settings.reviewAction']['result']>();
 const reviewRef=useRef<string|undefined>(undefined),epoch=useRef(0);
 useEffect(()=>{let active=true;void api.profiles().then(value=>{if(active)setProfiles(value);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[api,snapshot.profile.id]);
 useEffect(()=>{++epoch.current;setReview(undefined);reviewRef.current=undefined;return()=>{++epoch.current;};},[snapshot.profile.id]);
 useEffect(()=>()=>{if(reviewRef.current)void api.settings?.cancelAction(reviewRef.current).catch(()=>{});},[api]);
 useEffect(()=>{let active=true;setInspection(undefined);setError(false);if(snapshot.status==='ready')void api.installation!.inspect().then(value=>{if(active)setInspection(value);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[api,snapshot.profile.id,snapshot.status]);
 const proceed=async()=>{if(!mode)return;const currentEpoch=epoch.current;setBusy(true);setError(false);try{
  const current=await api.installation!.inspect();setInspection(current);
  if(currentEpoch!==epoch.current)return;
  if(mode==='fresh'?current.configuration.mode!=='first-run':!current.canConnect)throw new Error('Setup changed');
  await api.installation!.acknowledge();complete(mode);
 }catch{setError(true);}finally{setBusy(false);}};
 const chooseMode=async(next:typeof mode)=>{if(reviewRef.current)await api.settings!.cancelAction(reviewRef.current);reviewRef.current=undefined;setReview(undefined);setMode(next);};
 const changeProfile=async(id:string)=>{setBusy(true);setError(false);try{await chooseMode('existing');setInspection(undefined);await api.switchProfile(id);}catch{setError(true);}finally{setBusy(false);}};
 const createSeparate=async()=>{if(!api.settings)return;setBusy(true);setError(false);try{
  if(!review){const next=await api.settings.reviewAction({action:'profile.create',subject:name.trim(),value:''});reviewRef.current=next.reviewId;setReview(next);return;}
  const result=await api.settings.executeAction(review.reviewId,true);
  if(result.state!=='completed')throw new Error('Creation not confirmed');
  reviewRef.current=undefined;setReview(undefined);setInspection(undefined);await api.switchProfile(review.action.subject);
 }catch{setError(true);}finally{setBusy(false);}};
 return <section className="ec-page ec-installwelcome" aria-label={t('Welcome to EstaCoda')}><BrandEye/><h1>{t('Welcome to EstaCoda')}</h1><p>{t('Choose how to get started on this Mac.')}</p><LanguageSelect/>
 <div className="ec-installchoices"><Button disabled={busy} onClick={()=>void chooseMode('fresh').catch(()=>setError(true))} aria-pressed={mode==='fresh'}>{t('Set up EstaCoda')}</Button><Button disabled={busy} onClick={()=>void chooseMode('existing').catch(()=>setError(true))} aria-pressed={mode==='existing'}>{t('Use existing EstaCoda')}</Button></div>
 {mode==='fresh'&&<p>{t('Start with a workspace, a model, and your preferences.')}</p>}
 {mode==='existing'&&<><p>{t('Reuse your local settings and history. Credentials stay where they are.')}</p><label>{t('Local setup')}<select aria-label={t('Local setup')} disabled={busy} value={snapshot.profile.id} onChange={event=>void changeProfile(event.target.value)}>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label></>}
 {mode&&inspection&&<><dl><dt>{t('Configuration')}</dt><dd>{status(inspection.configuration.state)}</dd><dt>{t('Compatibility')}</dt><dd>{t(inspection.compatibility==='compatible'?'Compatible':inspection.compatibility==='incompatible'?'Update required':'Status unavailable')}</dd><dt>{t('Runtime')}</dt><dd>{t(inspection.runtime==='ready'?'Connected':inspection.runtime==='stopped'?'Starts when needed':'Needs attention')}</dd></dl>
 {mode==='fresh'&&inspection.configuration.mode!=='first-run'&&<><p>{t('An existing setup was found. Use it or create a separate setup without changing it.')}</p><label>{t('Separate setup name')}<input dir="ltr" aria-label={t('Separate setup name')} value={name} maxLength={64} disabled={busy||!!review} onChange={event=>setName(event.target.value)}/></label><p>{t('Creates an empty local setup. Your existing settings, credentials, and CLI default stay unchanged.')}</p>{review&&<p><bdi>{review.action.subject}</bdi> · {t('No credentials or history will be copied.')}</p>}<Button disabled={busy||!name.trim()||!api.settings} onClick={()=>void createSeparate()}>{t(review?'Confirm separate setup':'Review separate setup')}</Button></>}
 <Button disabled={busy||(mode==='fresh'?inspection.configuration.mode!=='first-run':!inspection.canConnect)} onClick={()=>void proceed()}>{t(mode==='fresh'?'Begin setup':'Continue with existing setup')}</Button></>}
 {mode&&!inspection&&snapshot.status==='ready'&&!error&&<LoadingStatus>{t('Checking local setup…')}</LoadingStatus>}
 {mode&&(error||snapshot.status!=='ready')&&<p role="alert">{t('Local setup could not be checked. Reconnect or open repair.')}</p>}
 {mode&&<div className="ec-actions"><Button className="ec-ghost" disabled={busy} onClick={repair}>{t('Open repair')}</Button><Button className="ec-ghost" disabled={busy} onClick={()=>void chooseMode(undefined).catch(()=>setError(true))}>{t('Back')}</Button></div>}
 </section>;
}
