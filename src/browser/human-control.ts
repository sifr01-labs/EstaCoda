import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {BrowserBackend,BrowserScreenshotResult} from '../contracts/browser.js';
import {validateHumanBrowserCommand,type HumanBrowserCommand,type HumanBrowserResult,type HumanBrowserFrame} from '../contracts/desktop-control/browser-human.js';
import {BrowserControlOwner} from './control-lease.js';
import {isSafeUrl,scanUrlForSecrets} from './url-safety.js';
import {loadWebsiteBlocklist,checkWebsiteAccess,type WebsitePolicyConfig} from './website-policy.js';
import {redactSensitiveText} from '../utils/redaction.js';
/** Runs only inside the existing runtime owner, never creates or reconnects a backend. */
export class HumanBrowserControl {
 #pending?:{id:string;kind:'password'|'one-time-code';destination:import('../contracts/secure-input.js').BrowserFieldSecureInputDestination};
 #browserId?:string;#frame?:{id:string;observation:NonNullable<BrowserScreenshotResult['observation']>};
 constructor(readonly backend:BrowserBackend,readonly owner:BrowserControlOwner,readonly validate:()=>Promise<void>,readonly security:{allowPrivateUrls?:boolean;websiteBlocklist?:WebsitePolicyConfig}={}){}
 async #clearEntry(){const pending=this.#pending;if(!pending)return;
  await this.backend.abortProtectedFieldGroup!([pending.destination]);await this.backend.releaseProtectedField!(pending.destination);this.#pending=undefined;
 }
 async #safe(url:string){let parsed:URL;try{parsed=new URL(url);}catch{throw new Error('Browser URL unavailable.');}
  if(parsed.username||parsed.password||scanUrlForSecrets(url)||!await isSafeUrl(url,{allowPrivateUrls:this.security.allowPrivateUrls===true})||checkWebsiteAccess(url,loadWebsiteBlocklist(this.security.websiteBlocklist??{}))?.allowed===false)throw new Error('Browser URL blocked.');
 }
 async #observe():Promise<HumanBrowserFrame>{
  const sessionId=this.#browserId!;const snapshot=await this.backend.snapshot!({sessionId});await this.#safe(snapshot.url);
  if(snapshot.sensitiveInputActive||this.backend.isSensitiveInputActive?.(sessionId))throw new Error('Protected browser input is active.');
  const capture=await this.backend.screenshot!({sessionId}),observation=capture.observation;
  if(!observation?.sanitized||observation.sessionId!==sessionId||!observation.identity||!observation.tabRef||capture.base64.length>12_000_000)throw new Error('Sanitized browser capture unavailable.');
  await this.validate();const latest=await this.backend.snapshot!({sessionId});await this.#safe(latest.url);
  if(latest.sensitiveInputActive||latest.identity.documentEpoch!==observation.identity.documentEpoch||latest.identity.actionRevision!==observation.identity.actionRevision||latest.tab?.ref!==observation.tabRef)throw new Error('Browser changed during capture.');
  const bytes=Buffer.from(capture.base64,'base64');let preview:Buffer|undefined;
  for(const width of [960,640,320]){preview=await sharp(bytes,{limitInputPixels:16_000_000}).resize({width,height:640,fit:'inside',withoutEnlargement:true}).jpeg({quality:50}).toBuffer();if(preview.length<=45000)break;}
  if(!preview||preview.length>45000)throw new Error('Browser preview exceeds limit.');
  const focused=await this.backend.preflightAction!('press',{sessionId,identity:latest.identity,tabRef:latest.tab?.ref});
  const id=randomUUID();this.#frame={id,observation};return{frameId:id,url:latest.url.slice(0,2048),title:redactSensitiveText(latest.title??'Browser').slice(0,160),image:preview.toString('base64'),observedAt:new Date().toISOString(),readiness:latest.readiness??'unknown',protectedFieldFocused:focused.target?.protectedInput===true,submitTargets:(latest.elements??[]).filter(element=>element.role==='button').slice(0,16).map(element=>({ref:element.ref,label:redactSensitiveText(element.name??'Submit').slice(0,120)}))};
 }
 async execute(command:HumanBrowserCommand):Promise<HumanBrowserResult>{
  try{return await this.#execute(command);}finally{if(command.action==='signin-deliver')command.value='';}
 }
 async #execute(command:HumanBrowserCommand):Promise<HumanBrowserResult>{
  validateHumanBrowserCommand(command);await this.validate();
  if(command.action==='inventory'){
   const workspace=this.backend.kind==='local-cdp'&&this.backend.workspace
    ?await this.owner.agent(()=>this.backend.workspace!({sessionId:command.browserId,action:{kind:'list'},assertHumanControl:()=>{}}))
    :{supported:false,reason:'Configure a supervised local browser in Settings. Cloud and legacy browsers support recorded viewing only.',truncated:false,sessions:[]};
   await this.validate();return {lease:null,frame:null,state:'agent',workspace};
  }
  if(command.action==='acquire'){
   // Only supervised sessions have current grounded input and sanitized visual leases.
   if(this.backend.kind!=='local-cdp'||!this.backend.preflightAction||!this.backend.snapshot||!this.backend.screenshot||!this.backend.click||!this.backend.press)throw new Error('Human control requires a supervised local browser.');
   const lease=this.owner.acquire(command.holder);await this.#clearEntry();this.owner.verify(command.holder,lease);this.#browserId=command.browserId;this.#frame=undefined;
   return{lease,frame:null,state:'human'};
  }
  if(command.browserId!==this.#browserId)throw new Error('Browser owner changed.');
  if(command.action==='release'){if(this.#pending)throw new Error('Cancel protected entry before returning control.');this.owner.release(command.holder,command.lease);this.#frame=undefined;this.#browserId=undefined;return{lease:null,frame:null,state:'agent'};}
  if(command.action==='renew'){this.owner.renew(command.holder,command.lease);return{lease:command.lease,frame:null,state:'human'};}
  return this.owner.human(command.holder,command.lease,command.sequence,async()=>{
   await this.validate();
   if(command.action==='signin-cancel'){await this.#clearEntry();return {lease:command.lease,frame:null,state:'human'};}
   if(command.action==='signin-deliver'){
    const pending=this.#pending;if(!pending||pending.id!==command.entryId)throw new Error('Protected entry expired.');
    const bytes=new TextEncoder().encode(command.value);command.value='';
    try{
     await this.validate();await this.#safe(pending.destination.expectedOrigin);
     await this.backend.deliverProtectedField!({destination:pending.destination,kind:pending.kind,value:bytes,assertHumanControl:()=>this.owner.verify(command.holder,command.lease)});
    }finally{bytes.fill(0);await this.#clearEntry();}
    return {lease:command.lease,frame:null,state:'human'};
   }
   if(this.#pending)throw new Error('Complete or cancel protected entry first.');
   if(command.action==='signin-prepare'){
    if(!this.backend.prepareProtectedField||!this.backend.verifyProtectedField||!this.backend.deliverProtectedField||!this.backend.abortProtectedFieldGroup||!this.backend.releaseProtectedField)throw new Error('Protected entry unavailable.');
    const frame=this.#frame;this.#frame=undefined;if(!frame||frame.id!==command.frameId)throw new Error('Browser frame is stale.');
    const bound={sessionId:command.browserId,identity:frame.observation.identity,tabRef:frame.observation.tabRef};
    const snapshot=await this.backend.snapshot!({sessionId:command.browserId});await this.#safe(snapshot.url);
    if(snapshot.identity.documentEpoch!==bound.identity!.documentEpoch||snapshot.identity.actionRevision!==bound.identity!.actionRevision||snapshot.tab?.ref!==bound.tabRef)throw new Error('Browser document changed.');
    const focused=await this.backend.preflightAction!('press',bound);await this.#safe(focused.url);
    if(!focused.target?.ref)throw new Error('Focus the password or code field first.');
    const destination=await this.backend.prepareProtectedField({...bound,ref:focused.target.ref,submitRef:command.submitRef});
    const pending={id:randomUUID(),kind:command.kind,destination};this.#pending=pending;
    try{
     if((await this.backend.verifyProtectedField({destination,kind:command.kind,phase:'before-collection'})).status!=='verified')throw new Error('Protected field unavailable.');
     await this.validate();this.owner.verify(command.holder,command.lease);
     return {lease:command.lease,frame:null,state:'human',entry:{id:pending.id,origin:destination.expectedOrigin}};
    }catch(error){await this.#clearEntry();throw error;}
   }
   if(command.action==='workspace'){
    if(!this.backend.workspace||this.backend.kind!=='local-cdp')throw new Error('Browser workspace unavailable.');
    this.#frame=undefined;const operation=command.operation;
    const assertHumanControl=()=>this.owner.verify(command.holder,command.lease);
    let nextId=this.#browserId!;
    if(operation.kind==='create')nextId=randomUUID();
    if(operation.kind==='navigate'||operation.kind==='create'||operation.kind==='new-tab')await this.#safe(operation.url);
    let workspace;
    if(operation.kind==='select-session'){
     workspace=await this.backend.workspace({sessionId:nextId,action:{kind:'list'},assertHumanControl});
     if(!workspace.sessions.some(session=>session.id===operation.sessionId))throw new Error('Browser session is not owned by this runtime.');
     nextId=operation.sessionId;
    }else workspace=await this.backend.workspace({sessionId:nextId,action:operation,assertHumanControl});
    await this.validate();assertHumanControl();this.#browserId=nextId;
    return {lease:command.lease,frame:null,state:'human',workspace:{...workspace,selectedSessionId:nextId}};
   }
   if(command.action==='input'){
    const frame=this.#frame,input=command.input!;this.#frame=undefined;
    if(!frame||frame.id!==input.frameId)throw new Error('Browser frame is stale.');
    const snapshot=await this.backend.snapshot!({sessionId:command.browserId});await this.#safe(snapshot.url);
    if(snapshot.sensitiveInputActive||snapshot.identity.documentEpoch!==frame.observation.identity!.documentEpoch||snapshot.identity.actionRevision!==frame.observation.identity!.actionRevision||snapshot.tab?.ref!==frame.observation.tabRef)throw new Error('Browser document changed.');
    const bound={assertHumanControl:()=>this.owner.verify(command.holder,command.lease),sessionId:command.browserId,identity:frame.observation.identity,tabRef:frame.observation.tabRef};
    if(input.kind==='pointer'){const point={...bound,visualTarget:{screenshotId:frame.observation.screenshotId,x:Math.floor(input.x*frame.observation.viewport.pixelWidth),y:Math.floor(input.y*frame.observation.viewport.pixelHeight)}};const preflight=await this.backend.preflightAction!('click',point);await this.#safe(preflight.url);if(!preflight.target?.ref)throw new Error('No grounded pointer target.');bound.assertHumanControl();await this.backend.click!({...bound,ref:preflight.target.ref});}
    else {const preflight=await this.backend.preflightAction!('press',bound);await this.#safe(preflight.url);if(preflight.target?.protectedInput)throw new Error('Use protected entry for this field.');bound.assertHumanControl();await this.backend.press!({...bound,ref:preflight.target?.ref,key:input.key,...([...input.key].length===1?{text:input.key}:{})});}
   }
   const frame=await this.#observe();await this.validate();return{lease:command.lease,frame,state:'human'};
  });
 }
}
