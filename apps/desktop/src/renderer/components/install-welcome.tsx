import {useEffect,useRef,useState} from 'react';
import type {DesktopApi,DesktopSnapshot} from '../../shared/desktop-api.js';
import type {MethodContracts} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {LanguageSelect} from './language-select.js';
import {Button,Icon} from './primitives.js';
import {LoadingStatus} from './loading.js';
import {OnboardingFrame} from './onboarding-frame.js';

export function InstallWelcome({api,snapshot,complete,repair}:{api:DesktopApi;snapshot:DesktopSnapshot;complete:(mode:'fresh'|'existing')=>void;repair:()=>void}){
 const {t}=useI18n(),[mode,setMode]=useState<'fresh'|'existing'>(),[inspection,setInspection]=useState<MethodContracts['setup.local']['result']>(),[busy,setBusy]=useState(false),[error,setError]=useState(false),[retry,setRetry]=useState(0);
 const [profiles,setProfiles]=useState<{id:string;label:string}[]>([]),[name,setName]=useState('');
 const reviewRef=useRef<string|undefined>(undefined),active=useRef(true),created=useRef<string|undefined>(undefined);
 useEffect(()=>{active.current=true;return()=>{active.current=false;if(reviewRef.current)void api.settings?.cancelAction(reviewRef.current).catch(()=>{});};},[api]);
 useEffect(()=>{let current=true;void api.profiles().then(value=>{if(current)setProfiles(value);}).catch(()=>{if(current)setError(true);});return()=>{current=false;};},[api,snapshot.profile.id,retry]);
 useEffect(()=>{let current=true;setInspection(undefined);if(snapshot.status==='ready')void api.installation!.inspect().then(async value=>{if(!current)return;setInspection(value);if(created.current===snapshot.profile.id&&value.configuration.mode==='first-run'){await api.installation!.acknowledge();if(current)complete('fresh');}}).catch(()=>{if(current)setError(true);});return()=>{current=false;};},[api,snapshot.profile.id,snapshot.status,retry]);
 const proceed=async()=>{if(!mode||busy)return;setBusy(true);setError(false);try{
  const current=await api.installation!.inspect();if(!active.current)return;setInspection(current);
  if(mode==='fresh'&&current.configuration.mode!=='first-run'){
   const review=await api.settings!.reviewAction({action:'profile.create',subject:name.trim(),value:''});reviewRef.current=review.reviewId;
   if(!active.current){await api.settings!.cancelAction(review.reviewId);return;}
   const result=await api.settings!.executeAction(review.reviewId,true);if(result.state!=='completed')throw new Error('Creation not confirmed');
   reviewRef.current=undefined;created.current=review.action.subject;setInspection(undefined);await api.switchProfile(review.action.subject);return;
  }
  if(mode==='existing'&&!current.canConnect)throw new Error('Setup unavailable');
  await api.installation!.acknowledge();if(active.current)complete(mode);
 }catch{if(active.current)setError(true);}finally{if(active.current)setBusy(false);}};
 const changeProfile=async(id:string)=>{setBusy(true);setError(false);try{setInspection(undefined);await api.switchProfile(id);}catch{setError(true);}finally{setBusy(false);}};
 const validName=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name.trim());
 const separate=mode==='fresh'&&inspection?.configuration.mode!=='first-run';
 return <OnboardingFrame brand title={t(mode==='fresh'?'Make it yours':mode==='existing'?'Pick up where you left off':'Welcome to EstaCoda')} subtitle={t(mode==='fresh'?'A model, a workspace, and you. Let’s get started.':mode==='existing'?'Bring your settings and conversations into the app.':'Your space to think, build, and get things done.')} footer={mode?<><Button className="ec-ghost" disabled={busy} onClick={()=>{created.current=undefined;setMode(undefined);setError(false);}}>{t('Back')}</Button><Button className="ec-primary" disabled={busy||!inspection||snapshot.status!=='ready'||(mode==='existing'?!inspection.canConnect:separate&&!validName)} onClick={()=>void proceed()}>{t(mode==='existing'?'Open EstaCoda':'Continue')}</Button></>:<span>{t('You can change your preferences in Settings.')}</span>}>
 {!mode?<><div className="ec-onboarding-choices"><button className="ec-onboarding-choice" onClick={()=>setMode('fresh')}><Icon name="sparkles"/><span><strong>{t('Start fresh')}</strong><small>{t('Create a space for your work.')}</small></span><Icon name="chevron-right"/></button><button className="ec-onboarding-choice" onClick={()=>setMode('existing')}><Icon name="folder-open"/><span><strong>{t('Use an existing setup')}</strong><small>{t('Keep your models, settings, and history.')}</small></span><Icon name="chevron-right"/></button></div><LanguageSelect/></>:<>
 {mode==='fresh'&&separate&&<><label className="ec-field">{t('Setup name')}<input dir="auto" value={name} disabled={busy} aria-describedby="ec-setup-name-help" maxLength={64} placeholder={t('For example, Personal')} onChange={event=>setName(event.target.value)}/></label><p id="ec-setup-name-help" className="ec-onboarding-note">{t('Use English letters, numbers, dots, dashes, or underscores, without spaces.')}</p><p className="ec-onboarding-note">{t('Your existing setup stays as it is. You can copy a model connection in the next step.')}</p></>}
 {mode==='existing'&&<><label className="ec-field">{t('Existing setup')}<select disabled={busy} value={snapshot.profile.id} onChange={event=>void changeProfile(event.target.value)}>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>{inspection?.canConnect&&<p className="ec-onboarding-ready"><Icon name="circle-check"/>{t('Ready to open')}</p>}{inspection&&!inspection.canConnect&&<div className="ec-onboarding-notice" role="status"><p>{t(inspection.compatibility==='incompatible'?'Update EstaCoda to use this setup.':'This setup needs a little attention before you can use it.')}</p><Button className="ec-ghost" onClick={repair}>{t('Open Settings')}</Button></div>}</>}
 {mode==='fresh'&&!separate&&<p className="ec-onboarding-note">{t('Choose your model next. Nothing is saved until you finish setup.')}</p>}
 {!inspection&&!error&&<LoadingStatus>{t('Getting things ready…')}</LoadingStatus>}
 </>}
 {error&&<div className="ec-onboarding-notice" role="alert"><p>{t('We couldn’t open this setup. Your existing settings are safe.')}</p><Button disabled={busy} onClick={()=>{setError(false);setRetry(value=>value+1);}}>{t('Try again')}</Button></div>}
 </OnboardingFrame>;
}
