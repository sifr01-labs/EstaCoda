import {useEffect,useRef,useState} from 'react';
import type {WorkInputRequest,WorkProjection} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {Button,Icon} from './primitives.js';
export function WorkInputPrompt({api,work,browser}:{api:DesktopApi;work:WorkProjection;browser:()=>void}){
 const {t}=useI18n();const[request,setRequest]=useState<WorkInputRequest|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const epoch=useRef(0);
 useEffect(()=>{let active=true,ready=true;let timer:ReturnType<typeof setTimeout>|undefined;
  const unsubscribe=api.onSnapshot(snapshot=>{ready=snapshot.status==='ready'&&snapshot.profile.id===work.profileId;if(!ready){epoch.current++;setRequest(null);setError(false);setBusy(false);}});
  const poll=async()=>{const generation=epoch.current;try{const next=ready?await api.workInput!.pending(work.id):null;if(active&&generation===epoch.current)setRequest(next);}catch{if(active&&generation===epoch.current)setRequest(null);}finally{if(active)timer=setTimeout(()=>void poll(),1000);}};
  void poll();return()=>{active=false;epoch.current++;clearTimeout(timer);unsubscribe();};
 },[api,work.id,work.profileId]);
 if(!request&&!error)return null;
 return <section className="ec-inputrequest" aria-label={t('Secure input required')}><Icon name="shield-check"/><div><b>{t('Secure input required')}</b><p>{error?t('Secure entry could not be completed. Inspect the browser before trying again.'):t('Enter your details in the protected window to continue.')} {request&&<bdi>{request.origin}</bdi>}</p><div className="ec-actions"><Button disabled={busy||!request} onClick={()=>{if(!request)return;const generation=epoch.current;setBusy(true);setError(false);void api.workInput!.open(work.id,request.id).catch(()=>{if(generation===epoch.current)setError(true);}).finally(()=>{if(generation===epoch.current)setBusy(false);});}}>{t('Enter securely')}</Button><Button className="ec-ghost" icon="globe" onClick={browser}>{t('Open browser')}</Button></div></div></section>;
}
