import {useEffect,useState} from 'react';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
/** Desktop's current bridge is local-only. Do not infer the execution host from target isolation. */
export function RuntimeDetails({api,profile}:{api:DesktopApi;profile:string}){
 const {t,status}=useI18n();const[state,setState]=useState<'ready'|'stopped'|'starting'|'disconnected'|'incompatible'|'unavailable'|null>(null);
 useEffect(()=>{setState(null);return api.onSnapshot(snapshot=>setState(snapshot.status!=='ready'||snapshot.profile.id!==profile?'disconnected':snapshot.runtime));},[api,profile]);
 if(!state)return null;
 return <div className="ec-kv"><dt>{t('Runtime')}</dt><dd>{t(api.platform==='darwin'?'Local Mac':api.platform==='win32'?'Local Windows':api.platform==='linux'?'Local Linux':'Local computer')}</dd><dd className="ec-subtle">{state==='ready'?t('Connected'):state==='stopped'?t('Not running'):status(state)}</dd></div>;
}
