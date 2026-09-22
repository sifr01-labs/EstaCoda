import type {DesktopUpdateState,InstallationStatus} from '../../shared/desktop-updates.js';
import {compatibleRelease,newerVersion,verifiedRelease,type DesktopRelease} from './release-feed.js';
import {readBounded,releaseResponse} from './network.js';
import {RELEASE_FEED} from './release-policy.js';
export type DiscoveryOptions={version:string;platform:string;arch:string;os:string;protocol:number;schema:number;publicKey:string|null;teamId:string|null;installation:()=>InstallationStatus;fetcher?:typeof fetch;now?:()=>number};
export class UpdateDiscovery {
 protected state:DesktopUpdateState;protected release?:DesktopRelease;private checking?:Promise<DesktopUpdateState>;private lastCheck=-Infinity;private timer?:ReturnType<typeof setTimeout>;private failures=0;
 constructor(protected readonly options:DiscoveryOptions){this.state={phase:options.publicKey&&options.teamId?'idle':'disabled',...(!options.publicKey||!options.teamId?{problem:'release_setup' as const}:{}),version:options.version,installation:options.installation(),automaticChecks:false};}
 preferences(automaticChecks:boolean):DesktopUpdateState{this.state={...this.state,automaticChecks};this.schedule(60000);return this.status();}
 dispose():void{if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
 private schedule(delay:number):void{this.dispose();if(!this.state.automaticChecks||!this.options.publicKey||!this.options.teamId)return;this.timer=setTimeout(()=>{void this.check().finally(()=>{this.failures=this.state.phase==='failed'?Math.min(this.failures+1,2):0;this.schedule(6*3600000*2**this.failures);});},delay);this.timer.unref?.();}
 status():DesktopUpdateState{return {...this.state,installation:this.options.installation()};}
 check():Promise<DesktopUpdateState>{
  if(this.checking)return this.checking;
  if(!this.options.publicKey||!this.options.teamId||['downloading','verifying','ready','installing'].includes(this.state.phase))return Promise.resolve(this.status());
  const now=(this.options.now??Date.now)();if(now-this.lastCheck<30000)return Promise.resolve(this.status());this.lastCheck=now;
  this.checking=this.performCheck(now).finally(()=>{this.checking=undefined;});return this.checking;
 }
 private async performCheck(now:number):Promise<DesktopUpdateState>{
  this.state={...this.state,phase:'checking',problem:undefined};
  try{
   const response=await releaseResponse(RELEASE_FEED,AbortSignal.timeout(15000),this.options.fetcher);
   const candidate=verifiedRelease(await readBounded(response,1024*1024),{publicKey:this.options.publicKey!,teamId:this.options.teamId!,now});
   this.release=undefined;
   if(!compatibleRelease(candidate,this.options)){this.state={...this.state,phase:'failed',problem:'incompatible'};}
   else if(!newerVersion(candidate.version,this.options.version)){this.state={...this.state,phase:'current',availableVersion:undefined,notesUrl:undefined};}
   else{this.release=candidate;this.state={...this.state,phase:'available',availableVersion:candidate.version,notesUrl:candidate.notesUrl};}
  }catch{this.state={...this.state,phase:'failed',problem:'check_failed'};}
  return this.status();
 }
}
