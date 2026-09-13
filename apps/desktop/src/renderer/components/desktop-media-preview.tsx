import {useEffect,useRef,useState} from 'react';
import type {ArtifactProjection} from '@estacoda/control-protocol';import type {DesktopApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';import {Button} from './primitives.js';
export function DesktopMediaPreview({api,artifact}:{api:NonNullable<DesktopApi['artifacts']>;artifact:ArtifactProjection}){
 const {t}=useI18n(),[url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(false);const current=useRef(''),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(current.current)URL.revokeObjectURL(current.current);};},[artifact]);
 if(!api.media||!['image/png','image/jpeg','image/gif','image/webp'].includes(artifact.mimeType))return null;
 const run=async(action:()=>Promise<void>)=>{setBusy(true);setError(false);try{await action();}catch{if(alive.current)setError(true);}finally{if(alive.current)setBusy(false);}};
 return <section aria-label={t('Media preview')}><Button disabled={busy} onClick={()=>void run(async()=>{const result=await api.media!(artifact.reference);if(!alive.current)return;if(result.mimeType!==artifact.mimeType)throw new Error();const bytes=Uint8Array.from(atob(result.data),c=>c.charCodeAt(0));if(current.current)URL.revokeObjectURL(current.current);current.current=URL.createObjectURL(new Blob([bytes],{type:result.mimeType}));setUrl(current.current);})}>{t('Load media preview')}</Button>{api.save&&<Button disabled={busy} onClick={()=>void run(async()=>{await api.save!(artifact.reference);})}>{t('Save media…')}</Button>}{url&&<img src={url} alt={artifact.displayName} style={{maxWidth:'100%',maxHeight:600,objectFit:'contain'}}/>}{error&&<p role="alert">{t('Media unavailable or changed.')}</p>}</section>;
}
