import {useEffect,useRef,useState} from 'react';
import type {DesktopApi} from '../../shared/desktop-api.js';
import type {SetupDetection} from '@estacoda/control-protocol';
import {useI18n} from '../i18n.js';
import {LanguageSelect} from './language-select.js';
import {BrandEye,Wordmark,Button} from './primitives.js';
export const onboardingSteps=['Welcome to EstaCoda','Language and style','Workspace and trust','Model route','Safety','Agent Evolution','Optional capabilities','Confirm setup','Verify and start'] as const;
/** Draft navigation never applies configuration. Returning to a step preserves choices in this window. */
export function OnboardingWizard({api,repair,complete}:{api:DesktopApi;repair:()=>void;complete:()=>void}){
 const {t}=useI18n(),[detection,setDetection]=useState<SetupDetection>(),[step,setStep]=useState(0),[paused,setPaused]=useState(false),[error,setError]=useState(false),[busy,setBusy]=useState(false),[style,setStyle]=useState('standard');const title=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{let active=true;void api.onboarding!.detect().then(value=>{if(active)setDetection(value);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[api]);
 useEffect(()=>{title.current?.focus();},[step,paused]);
 const begin=async()=>{setBusy(true);setError(false);try{setDetection(await api.onboarding!.bootstrap());setStep(1);}catch{setError(true);}finally{setBusy(false);}};
 return <section className="ec-page ec-onboarding" aria-label={t('Set up EstaCoda')}><BrandEye/><Wordmark/><h1 ref={title} tabIndex={-1}>{t(onboardingSteps[step]!)}</h1>{error&&<p role="alert">{t('Setup could not continue. Retry or open repair.')}</p>}{!detection&&!error&&<p role="status">{t('Loading…')}</p>}
 {detection&&detection.mode!=='first-run'?<><p>{t('Existing settings are preserved. Use Settings to review repairs.')}</p><Button onClick={repair}>{t('Open repair')}</Button>{detection.launchReady&&<Button onClick={complete}>{t('Continue')}</Button>}</>:paused?<><p>{t('Setup paused. No configuration or credentials were saved.')}</p><Button onClick={()=>setPaused(false)}>{t('Resume setup')}</Button></>:<>
 {step===0&&<><p>{t('Choose where your agent works and review what it can do.')}</p><p>{t('Your choices stay in a draft until you confirm setup.')}</p><Button disabled={busy||!detection} onClick={()=>void begin()}>{t('Begin setup')}</Button></>}
 {step===1&&<><LanguageSelect/><label>{t('Response style')}<select value={style} onChange={event=>setStyle(event.target.value)}><option value="standard">{t('Standard')}</option><option value="arabic-light">{t('Arabic light')}</option><option value="kemet-full">{t('Kemet full')}</option></select></label></>}
 {step>0&&<div className="ec-actions"><Button disabled={busy} onClick={()=>setStep(step-1)}>{t('Back')}</Button><Button disabled={busy||step>=1} onClick={()=>setStep(step+1)}>{t('Continue')}</Button></div>}
 <Button className="ec-ghost" disabled={busy} onClick={()=>setPaused(true)}>{t('Cancel setup')}</Button></>}{error&&<Button onClick={repair}>{t('Open repair')}</Button>}</section>;
}
