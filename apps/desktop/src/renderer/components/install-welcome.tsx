import {useEffect,useState} from 'react';
import type {DesktopApi,DesktopSnapshot} from '../../shared/desktop-api.js';
import type {MethodContracts} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {LanguageSelect} from './language-select.js';
import {BrandEye,Button} from './primitives.js';
import {LoadingStatus} from './loading.js';

export function InstallWelcome({api,snapshot,complete,repair}:{api:DesktopApi;snapshot:DesktopSnapshot;complete:(mode:'fresh'|'existing')=>void;repair:()=>void}){
 const {t,status}=useI18n(),[mode,setMode]=useState<'fresh'|'existing'>(),[inspection,setInspection]=useState<MethodContracts['setup.local']['result']>(),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 useEffect(()=>{let active=true;setInspection(undefined);setError(false);if(snapshot.status==='ready')void api.installation!.inspect().then(value=>{if(active)setInspection(value);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[api,snapshot.profile.id,snapshot.status]);
 const proceed=async()=>{if(!mode)return;setBusy(true);setError(false);try{
  const current=await api.installation!.inspect();setInspection(current);
  if(mode==='fresh'?current.configuration.mode!=='first-run':!current.canConnect)throw new Error('Setup changed');
  await api.installation!.acknowledge();complete(mode);
 }catch{setError(true);}finally{setBusy(false);}};
 return <section className="ec-page ec-installwelcome" aria-label={t('Welcome to EstaCoda')}><BrandEye/><h1>{t('Welcome to EstaCoda')}</h1><p>{t('Choose how to get started on this Mac.')}</p><LanguageSelect/>
 <div className="ec-installchoices"><Button disabled={busy} onClick={()=>setMode('fresh')} aria-pressed={mode==='fresh'}>{t('Set up EstaCoda')}</Button><Button disabled={busy} onClick={()=>setMode('existing')} aria-pressed={mode==='existing'}>{t('Use existing EstaCoda')}</Button></div>
 {mode==='fresh'&&<p>{t('Start with a workspace, a model, and your preferences.')}</p>}
 {mode==='existing'&&<><p>{t('Reuse your local settings and history. Credentials stay where they are.')}</p><p><bdi>{snapshot.profile.label}</bdi></p></>}
 {mode&&inspection&&<><dl><dt>{t('Configuration')}</dt><dd>{status(inspection.configuration.state)}</dd><dt>{t('Compatibility')}</dt><dd>{t(inspection.compatibility==='compatible'?'Compatible':inspection.compatibility==='incompatible'?'Update required':'Status unavailable')}</dd><dt>{t('Runtime')}</dt><dd>{t(inspection.runtime==='ready'?'Connected':inspection.runtime==='stopped'?'Starts when needed':'Needs attention')}</dd></dl>
 {mode==='fresh'&&inspection.configuration.mode!=='first-run'&&<p>{t('An existing setup was found. Use it or create a separate setup without changing it.')}</p>}
 <Button disabled={busy||(mode==='fresh'?inspection.configuration.mode!=='first-run':!inspection.canConnect)} onClick={()=>void proceed()}>{t(mode==='fresh'?'Begin setup':'Continue with existing setup')}</Button></>}
 {mode&&!inspection&&snapshot.status==='ready'&&!error&&<LoadingStatus>{t('Checking local setup…')}</LoadingStatus>}
 {mode&&(error||snapshot.status!=='ready')&&<p role="alert">{t('Local setup could not be checked. Reconnect or open repair.')}</p>}
 {mode&&<div className="ec-actions"><Button className="ec-ghost" disabled={busy} onClick={repair}>{t('Open repair')}</Button><Button className="ec-ghost" disabled={busy} onClick={()=>setMode(undefined)}>{t('Back')}</Button></div>}
 </section>;
}
