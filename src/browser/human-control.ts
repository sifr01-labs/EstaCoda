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
 #browserId?:string;#frame?:{id:string;observation:NonNullable<BrowserScreenshotResult['observation']>};
 constructor(readonly backend:BrowserBackend,readonly owner:BrowserControlOwner,readonly validate:()=>Promise<void>,readonly security:{allowPrivateUrls?:boolean;websiteBlocklist?:WebsitePolicyConfig}={}){}
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
  const id=randomUUID();this.#frame={id,observation};return{frameId:id,url:latest.url.slice(0,2048),title:redactSensitiveText(latest.title??'Browser').slice(0,160),image:preview.toString('base64'),observedAt:new Date().toISOString()};
 }
 async execute(command:HumanBrowserCommand):Promise<HumanBrowserResult>{
  validateHumanBrowserCommand(command);await this.validate();
  if(command.action==='acquire'){
   // Only supervised sessions have current grounded input and sanitized visual leases.
   if(this.backend.kind!=='local-cdp'||!this.backend.preflightAction||!this.backend.snapshot||!this.backend.screenshot||!this.backend.click||!this.backend.press)throw new Error('Human control requires a supervised local browser.');
   const lease=this.owner.acquire(command.holder);this.#browserId=command.browserId;this.#frame=undefined;
   return{lease,frame:null,state:'human'};
  }
  if(command.browserId!==this.#browserId)throw new Error('Browser owner changed.');
  if(command.action==='release'){this.owner.release(command.holder,command.lease);this.#frame=undefined;this.#browserId=undefined;return{lease:null,frame:null,state:'agent'};}
  if(command.action==='renew'){this.owner.renew(command.holder,command.lease);return{lease:command.lease,frame:null,state:'human'};}
  return this.owner.human(command.holder,command.lease,command.sequence,async()=>{
   await this.validate();
   if(command.action==='input'){
    const frame=this.#frame,input=command.input!;this.#frame=undefined;
    if(!frame||frame.id!==input.frameId)throw new Error('Browser frame is stale.');
    const snapshot=await this.backend.snapshot!({sessionId:command.browserId});await this.#safe(snapshot.url);
    if(snapshot.sensitiveInputActive||snapshot.identity.documentEpoch!==frame.observation.identity!.documentEpoch||snapshot.identity.actionRevision!==frame.observation.identity!.actionRevision||snapshot.tab?.ref!==frame.observation.tabRef)throw new Error('Browser document changed.');
    const bound={assertHumanControl:()=>this.owner.verify(command.holder,command.lease),sessionId:command.browserId,identity:frame.observation.identity,tabRef:frame.observation.tabRef};
    if(input.kind==='pointer'){const point={...bound,visualTarget:{screenshotId:frame.observation.screenshotId,x:Math.floor(input.x*frame.observation.viewport.pixelWidth),y:Math.floor(input.y*frame.observation.viewport.pixelHeight)}};const preflight=await this.backend.preflightAction!('click',point);await this.#safe(preflight.url);if(!preflight.target?.ref)throw new Error('No grounded pointer target.');bound.assertHumanControl();await this.backend.click!({...bound,ref:preflight.target.ref});}
    else {const preflight=await this.backend.preflightAction!('press',bound);await this.#safe(preflight.url);bound.assertHumanControl();await this.backend.press!({...bound,ref:preflight.target?.ref,key:input.key,...([...input.key].length===1?{text:input.key}:{})});}
   }
   const frame=await this.#observe();await this.validate();return{lease:command.lease,frame,state:'human'};
  });
 }
}
