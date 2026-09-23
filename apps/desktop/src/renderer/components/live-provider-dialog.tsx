import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {AUXILIARY_SLOTS,type RouteRole,type OAuthStatus,type CandidateRoute,type CandidateVerification,type ModelRouteDraft,type ModelApplyReceipt,type ProviderProjection,type ModelProjection} from '@estacoda/control-protocol';
import type {DesktopModelsApi} from '../../shared/desktop-api.js';
import {useI18n} from '../i18n.js';
import {Button,Icon} from './primitives.js';
import {ProviderMark} from './provider-mark.js';
import {ModelMetadata} from './model-metadata.js';
import {VerificationDetails} from './verification-details.js';
import {LoadingStatus} from './loading.js';

type Props={selection?:{providerId:string;modelId:string;role:RouteRole};modelInfo?:ModelProjection;onReviewed?:(setupId:string,draft:ModelRouteDraft)=>void;returnFocus?:HTMLElement|null;api:DesktopModelsApi;providers:ProviderProjection[];close:()=>void;saved:()=>void};
export function LiveProviderDialog({api,providers,close,saved,returnFocus,onReviewed,selection,modelInfo}:Props){
 const {t,status}=useI18n();
 const choices=providers.filter(p=>p.metadata?.configurable&&(p.authMethods.includes('api_key')||p.authMethods.includes('none')||p.id==='codex'));
 const [role,setRole]=useState<RouteRole['role']>(selection?.role.role??'primary');
 const [slot,setSlot]=useState<(typeof AUXILIARY_SLOTS)[number]>(selection?.role.slot??'assessor');
 const [fallbackToMain,setFallbackToMain]=useState(selection?.role.fallbackToMain??true);
 const [provider,setProvider]=useState(selection?.providerId??choices.find(p=>p.id==='kimi')?.id??choices[0]?.id??'');
 const [model,setModel]=useState(selection?.modelId??'');
 const [customId,setCustomId]=useState('custom-endpoint'),[endpoint,setEndpoint]=useState('http://localhost:11434/v1');
 const [auth,setAuth]=useState<'none'|'api_key'>('none'),[mode,setMode]=useState<CandidateRoute['apiMode']>('custom_openai_compatible');
 const [network,setNetwork]=useState(true),[privateEndpoint,setPrivateEndpoint]=useState(false),[context,setContext]=useState(''),[output,setOutput]=useState('');
 const [step,setStep]=useState<'connect'|'review'|'done'>('connect');
 const [oauth,setOAuth]=useState<OAuthStatus>(),[staged,setStaged]=useState(false),[setupId,setSetupId]=useState<string>();
 const [verification,setVerification]=useState<CandidateVerification>(),[draft,setDraft]=useState<ModelRouteDraft>(),[receipt,setReceipt]=useState<ModelApplyReceipt>();
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[copy,setCopy]=useState<'idle'|'copied'|'failed'>('idle');
 const dialog=useRef<HTMLElement>(null),active=useRef(false),setup=useRef<string|undefined>(undefined),copyTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),saveAttempted=useRef(false),inFlight=useRef(false),next=useRef<HTMLDivElement>(null);
 const selected=choices.find(p=>p.id===provider),custom=provider==='local'||provider==='__custom';
 const providerName=selected?.label??t('Custom provider');
 const route:CandidateRoute={providerId:provider==='__custom'?customId:provider,modelId:model.trim(),endpoint:custom?endpoint:selected?.metadata?.defaultEndpoint??'',apiMode:custom?mode:selected?.metadata?.apiMode as CandidateRoute['apiMode'],authMethod:custom?auth:provider==='codex'?'oauth':selected?.authMethods.includes('api_key')?'api_key':'none',allowPrivateEndpoint:custom&&privateEndpoint,...(custom?{enableNetwork:network,...(context&&role!=='provider'?{contextWindowTokens:Number(context)}:{}),...(output&&role!=='auxiliary'&&role!=='provider'?{maxTokens:Number(output)}:{})}:{})};
 const routeRole:RouteRole={role,...(role==='auxiliary'?{slot,fallbackToMain}:{})};
 const ready=staged&&!busy&&(!verification||verification.state==='passed');
 const savedOK=receipt?.state==='applied';
 const displayModel=modelInfo?.label??model;
 const useAs=role==='provider'?t('Make available'):role==='primary'?t('Primary model'):role==='fallback'?t('Fallback model'):t('Specialist: {slot}',{slot:status(slot)});
 const pendingOAuth=oauth?.state==='pending'||oauth?.state==='starting';
 useEffect(()=>{
  active.current=true;const restore=returnFocus??document.activeElement as HTMLElement;
  const background=Array.from(document.querySelectorAll<HTMLElement>('#ec-shell-content,.ec-titlebar,.ec-runtimebar')),previous=background.map(e=>e.inert);background.forEach(e=>e.inert=true);
  dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
  return()=>{active.current=false;clearTimeout(copyTimer.current);background.forEach((e,i)=>e.inert=previous[i]!);if(restore?.isConnected)restore.focus();queueMicrotask(()=>{if(!active.current&&setup.current)void api.cancel(setup.current).catch(()=>{});});};
 },[api]);
 useEffect(()=>{
  if(!setupId||!pendingOAuth)return;let cancelled=false;
  const timer=setInterval(()=>{void api.oauthStatus(setupId).then(result=>{if(!cancelled&&active.current){setOAuth(result);if(result.state==='authorized')setStaged(true);}}).catch(()=>{if(!cancelled&&active.current)setOAuth({...oauth!,state:'failed',candidateId:null,userCode:null,verificationUrl:null});});},1500);
  return()=>{cancelled=true;clearInterval(timer);};
 },[api,setupId,pendingOAuth]);
 useEffect(()=>{setCopy('idle');clearTimeout(copyTimer.current);},[oauth?.state,oauth?.userCode]);
 useEffect(()=>{if(staged)next.current?.querySelector<HTMLButtonElement>('.ec-primary')?.focus();},[staged]);
 useLayoutEffect(()=>{const element=document.activeElement;if(dialog.current&&(!dialog.current.contains(element)||element?.matches(':disabled')))dialog.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();},[busy,step,receipt]);
 async function action(work:()=>Promise<void>){
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
  try{await work();}catch{if(active.current)setError(t('Setup could not finish. Try again or reconnect.'));}
  finally{inFlight.current=false;if(active.current)setBusy(false);}
 }
 async function stage(){await action(async()=>{
  const result=await api.begin(route);setup.current=result.setupId;if(!active.current){await api.cancel(result.setupId);return;}setSetupId(result.setupId);
  if(route.authMethod==='none')setStaged(true);
  else if(route.authMethod==='oauth'){const result=await api.oauthStart(setup.current);if(active.current){setOAuth(result);if(result.state==='authorized')setStaged(true);}}
  else{await api.stage(setup.current);if(active.current)setStaged(true);}
 });}
 async function cancel(){
  // Cancellation can interrupt an in-flight connection test, but never resubmits a save.
  try{if(setup.current){const result=await api.cancel(setup.current);if(!result.cancelled&&!receipt){if(active.current)setError(t('Save status is not confirmed. Check save status before continuing.'));return;}setup.current=undefined;}close();}
  catch{if(active.current)setError(t('Setup could not finish. Try again or reconnect.'));}
 }
 async function restart(){await action(async()=>{
  if(setup.current&&!(await api.cancel(setup.current)).cancelled)throw Error('Save still settling');
  setup.current=undefined;setSetupId(undefined);setOAuth(undefined);setStaged(false);setDraft(undefined);setVerification(undefined);setStep('connect');
 });}
 async function reconcile(){
  const result=await api.inspect();
  if(!result||result.operationId!==draft?.draftId)throw Error('Save identity changed');
  if(active.current){setReceipt(result);if(result.state==='applied')saved();}
 }
 async function save(){await action(async()=>{
  if(onReviewed){const id=setupId!;setup.current=undefined;onReviewed(id,draft!);close();return;}
  if(saveAttempted.current)return;saveAttempted.current=true;setStep('done');
  let result:ModelApplyReceipt|undefined;
  try{result=await api.apply(setupId!);}catch{/* Reconcile this operation, never repeat Apply. */}
  if(!active.current)return;
  if(result&&result.operationId===draft?.draftId){setReceipt(result);if(result.state==='applied'){saved();return;}}
  setReceipt({operationId:draft!.draftId,state:'uncertain',verification:'not_tested'});
  try{await reconcile();}catch{if(active.current)setError(t('Save status is not confirmed. Check save status before continuing.'));}
 });}
 async function testConnection(){await action(async()=>{
  let testSetup:string|undefined;
  try{
   let result:CandidateVerification;
   if(savedOK){const reviewed=await api.reviewConfigured({providerId:route.providerId,modelId:route.modelId,...routeRole,verification:{endpoint:route.endpoint}});testSetup=reviewed.setupId;if(!active.current)return;result=await api.verifyReviewed(testSetup,privateEndpoint);}
   else result=await api.verify(setupId!);
   if(active.current)setVerification(result);
  }finally{if(testSetup)await api.cancel(testSetup);}
 });}
 async function copyCode(){
  if(oauth?.state!=='pending'||!oauth.userCode)return;
  try{if(window.desktop?.clipboard)await window.desktop.clipboard.writeText(oauth.userCode);else await navigator.clipboard.writeText(oauth.userCode);if(active.current)setCopy('copied');}
  catch{if(active.current)setCopy('failed');}
  clearTimeout(copyTimer.current);copyTimer.current=setTimeout(()=>{if(active.current)setCopy('idle');},1800);
 }
 const field=(label:string,value:React.ReactNode)=><div className="ec-setup-kv"><dt>{label}</dt><dd>{value}</dd></div>;
 const summary=<div className="ec-setup-model"><ProviderMark id={route.providerId} label={providerName}/><div className="ec-model-grow"><h3><bdi>{displayModel||t('Choose a model')}</bdi></h3><p><bdi>{providerName}</bdi></p>{modelInfo&&<ModelMetadata model={modelInfo}/>}</div></div>;
 const testStatus=verification?.state==='passed'?t('Connection test passed'):verification?t('Connection test failed'):t('Connection not tested');
 const testBlock=<div className="ec-setup-test"><div className="ec-setup-testhead"><span className={verification?.state==='passed'?'ec-setup-success':''}>{verification&&<Icon name={verification.state==='passed'?'circle-check':'circle-alert'}/>} {testStatus}</span><Button className="ec-ghost" disabled={busy||route.enableNetwork===false||!staged||(!savedOK&&Boolean(verification&&verification.state!=='passed'))} onClick={()=>void testConnection()}>{t('Test connection')}</Button></div><p>{t('Sends one small model request and may incur provider charges.')}</p>{verification&&<details><summary>{t('Test details')}</summary><VerificationDetails result={verification}/></details>}</div>;
 const advanced=<details className="ec-setup-advanced"><summary>{t('Advanced details')}</summary>{step==='connect'&&custom?<>
  <label className="ec-field">{t('API mode')}<select value={mode} disabled={busy||Boolean(setupId)} onChange={e=>setMode(e.target.value as typeof mode)}><option value="custom_openai_compatible">OpenAI-compatible</option><option value="openai_chat_completions">Chat Completions</option><option value="openai_responses">Responses</option></select></label>
  {role!=='provider'&&<label className="ec-field">{t('Context override')}<input type="number" min="1" max="1000000000" value={context} disabled={busy||Boolean(setupId)} onChange={e=>setContext(e.target.value)} placeholder={t('Use catalog default')}/></label>}
  {role!=='auxiliary'&&role!=='provider'&&<label className="ec-field">{t('Output cap')}<input type="number" min="1" max="1000000000" value={output} disabled={busy||Boolean(setupId)} onChange={e=>setOutput(e.target.value)} placeholder={t('Use model default')}/></label>}
  <label className="ec-setup-check"><input type="checkbox" checked={network} disabled={busy||Boolean(setupId)} onChange={e=>setNetwork(e.target.checked)}/>{t('Enable provider requests')}</label>
 </>:<dl>{field(t('Endpoint'),<bdi dir="ltr">{route.endpoint}</bdi>)}{field(t('API mode'),route.apiMode?.replaceAll('_',' '))}{field(t('Provider requests'),route.enableNetwork===false?t('Disabled'):t('Enabled'))}{role!=='provider'&&<>{field(t('Context limit'),context||t('Catalog default'))}{role!=='auxiliary'&&field(t('Output limit'),output||t('Model default'))}</>}</dl>}
 <label className="ec-setup-check"><input type="checkbox" checked={privateEndpoint} disabled={busy||Boolean(setupId)&&!savedOK} onChange={e=>setPrivateEndpoint(e.target.checked)}/>{t('Allow this local or private endpoint for verification')}</label>
 </details>;
 return createPortal(<div className="ec-modalback"><section ref={dialog} className="ec-modal ec-provider-setup" role="dialog" aria-modal="true" aria-labelledby="ec-live-setup-title" onKeyDown={e=>{
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();void cancel();}
  if(e.key==='Tab'){const controls=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')).filter(e=>e.getClientRects().length>0),first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
 }}>
 <header className="ec-modalhead"><h2 id="ec-live-setup-title">{step==='done'?(savedOK?t('Changes saved'):t('Check save status')):step==='review'?t('Review changes'):t('Connect {provider}',{provider:providerName})}</h2><Button className="ec-ghost ec-iconbutton" icon="x" aria-label={t('Close provider setup')} onClick={()=>void cancel()}/></header>
 {!onReviewed&&<ol className="ec-setup-steps" aria-label={t('Setup progress')}>{(['connect','review','done'] as const).map((s,i)=><li key={s} aria-current={step===s?'step':undefined}><span>{i+1}</span>{t(s==='connect'?'Connect':s==='review'?'Review':'Done')}</li>)}</ol>}
 <div className="ec-setup-body">
 {error&&<p role="alert" className="ec-setup-warning">{error}</p>}
 {summary}
 {step==='connect'&&<>
 {!selection&&<label className="ec-field">{t('Provider')}<select value={provider} disabled={busy||Boolean(setupId)} onChange={e=>setProvider(e.target.value)}>{choices.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}<option value="__custom">{t('Custom OpenAI-compatible endpoint')}</option></select></label>}
 {!selection&&!onReviewed&&<label className="ec-field">{t('Use as')}<select value={role} disabled={busy||Boolean(setupId)} onChange={e=>setRole(e.target.value as typeof role)}><option value="primary">{t('Primary')}</option><option value="fallback">{t('Fallback')}</option><option value="auxiliary">{t('Specialist')}</option></select></label>}
 {!selection?.modelId&&<label className="ec-field">{t('Model ID')}<input value={model} disabled={busy||Boolean(setupId)} maxLength={200} autoComplete="off" onChange={e=>setModel(e.target.value)}/></label>}
 {custom&&<>
 {provider==='__custom'&&<label className="ec-field">{t('Provider ID')}<input value={customId} disabled={busy||Boolean(setupId)} maxLength={80} onChange={e=>setCustomId(e.target.value)}/></label>}
 <label className="ec-field">{t('Endpoint')}<input value={endpoint} disabled={busy||Boolean(setupId)} maxLength={2048} onChange={e=>setEndpoint(e.target.value)}/></label>
 <label className="ec-field">{t('Authentication')}<select value={auth} disabled={busy||Boolean(setupId)} onChange={e=>setAuth(e.target.value as typeof auth)}><option value="none">{t('No authentication')}</option><option value="api_key">{t('API key')}</option></select></label>
 </>}
 {role==='auxiliary'&&<>{!selection&&<label className="ec-field">{t('Specialist')}<select value={slot} disabled={busy||Boolean(setupId)} onChange={e=>setSlot(e.target.value as typeof slot)}>{AUXILIARY_SLOTS.map(s=><option key={s} value={s}>{status(s)}</option>)}</select></label>}<label className="ec-setup-check"><input type="checkbox" checked={fallbackToMain} disabled={busy||Boolean(draft)} onChange={e=>setFallbackToMain(e.target.checked)}/>{t('Fall back to primary')}</label></>}
 <section className="ec-setup-auth"><h3>{t('Authorization')}</h3>
 {staged?<p className="ec-setup-success" role="status"><Icon name="circle-check"/>{route.authMethod==='none'?t('No authorization required.'):t('Authorized. Save to finish setup.')}</p>:pendingOAuth?<div className="ec-setup-oauth"><p>{t('Enter this code on the sign-in page.')}</p>{oauth?.userCode&&<div className="ec-setup-code"><bdi dir="ltr">{oauth.userCode}</bdi><Button className="ec-ghost" icon={copy==='copied'?'check':'copy'} onClick={()=>void copyCode()}>{copy==='copied'?t('Copied'):t('Copy code')}</Button></div>}<span className="ec-sr-only" role="status">{copy==='copied'?t('Copied'):copy==='failed'?t('Could not copy. Select the code and copy it manually.'):''}</span><Button icon="arrow-up-right" onClick={()=>void action(()=>api.oauthOpen(setupId!))}>{t('Open sign-in page')}</Button></div>:oauth?<p role="status">{t('Authorization expired or was interrupted. Get a new code to continue.')}</p>:<Button className="ec-setup-authorize" icon="key-round" disabled={busy||Boolean(setupId)||!model.trim()||!route.endpoint} onClick={()=>void stage()}>{route.authMethod==='none'?t('Continue without a credential'):route.authMethod==='oauth'?t('Authorize Codex'):t('Enter API key privately')}</Button>}
 {setupId&&!pendingOAuth&&<Button className="ec-ghost ec-setup-reset" disabled={busy} onClick={()=>void restart()}>{oauth&&!staged?t('Get a new code'):t('Reset setup')}</Button>}
 {!staged&&!oauth&&<p className="ec-footnote">{t('Credentials are saved only when you finish setup.')}</p>}
 </section>
 {advanced}
 {staged&&testBlock}
 </>}
 {step==='review'&&<>
 <dl className="ec-setup-review">{field(t('Use as'),useAs)}{role==='fallback'&&field(t('Fallback priority'),t('After existing fallbacks'))}{role==='auxiliary'&&field(t('Fall back to primary'),fallbackToMain?t('Enabled'):t('Disabled'))}{field(t('Authorization'),route.authMethod==='none'?t('Not required'):t('Authorized'))}{field(t('Connection test'),testStatus)}</dl>
 <p className="ec-footnote">{role==='provider'?t('Provider only · model selections stay unchanged'):t('New work uses this selection. Existing work keeps its current model.')}</p>
 {advanced}
 </>}
 {step==='done'&&savedOK&&<>
 <div className="ec-setup-saved" role="status"><Icon name="circle-check"/><div><p>{receipt.issue||receipt.verification==='repair_required'?t('Your changes are saved. Resolve the issue below before using this model.'):role==='provider'?t('This provider is now available for model selection.'):t('Saved as {role}.',{role:useAs})}</p></div></div>
 {receipt.issue?<div className="ec-setup-warning" role="alert"><strong>{t('Needs attention')}</strong><p><bdi>{receipt.issue.providerId} / {receipt.issue.modelId}</bdi></p><p>{t(receipt.issue.reason==='credential_required'?'Authorization is missing. Reconnect this provider.':receipt.issue.reason==='authorization_expired'?'Authorization has expired. Reconnect this provider.':receipt.issue.reason==='model_unavailable'?'This model is unavailable. Choose another model.':'Configuration could not be checked. Open the provider to review its setup.')}</p></div>:receipt.verification==='repair_required'&&<p className="ec-setup-warning">{t('Configuration could not be checked. Open the provider to review its setup.')}</p>}
 {testBlock}
 {advanced}
 </>}
 {step==='done'&&!savedOK&&<p role="status">{busy?t('Checking save status…'):t('Save status is not confirmed. Check save status before continuing.')}</p>}
 {busy&&<LoadingStatus>{step==='done'?t('Checking save status…'):t('Waiting for setup…')}</LoadingStatus>}
 </div>
 <footer ref={next} className="ec-setup-footer">
 {!savedOK&&<Button className="ec-ghost" disabled={busy&&step==='done'} onClick={()=>step==='review'?setStep('connect'):void cancel()}>{step==='review'?t('Back'):step==='done'?t('Close'):t('Cancel')}</Button>}
 {step==='connect'?<Button className="ec-primary" disabled={!ready} onClick={()=>void action(async()=>{const result=draft??await api.review(setupId!,routeRole);if(active.current){if(onReviewed){setup.current=undefined;onReviewed(setupId!,result);close();}else{setDraft(result);setStep('review');}}})}>{t(onReviewed?'Use this model':'Continue')}</Button>:step==='review'?<Button className="ec-primary" disabled={busy} onClick={()=>void save()}>{onReviewed?t('Keep in setup draft'):t('Save changes')}</Button>:savedOK?<Button className="ec-primary" onClick={()=>{saved();close();}}>{t('Done')}</Button>:<Button className="ec-primary" disabled={busy} onClick={()=>void action(reconcile)}>{t('Check save status')}</Button>}
 </footer>
 </section></div>,document.querySelector('.ec-window')!);
}
