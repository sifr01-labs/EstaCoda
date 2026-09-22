import {UpdateDiscovery,type DiscoveryOptions} from './discovery.js';
import {stageDownload,type ArchiveVerifier} from './download.js';
import {UpdateCoordinator} from './coordinator.js';
import type {DesktopUpdateState,UpdateProblem} from '../../shared/desktop-updates.js';
export class UpdateDownloads extends UpdateDiscovery {
 protected archive?:string;private downloadTask?:Promise<DesktopUpdateState>;private cancellation?:AbortController;
 constructor(options:DiscoveryOptions,protected readonly coordinator:UpdateCoordinator,protected readonly verifier?:ArchiveVerifier){super(options);}
 protected async staged():Promise<void>{}
 download():Promise<DesktopUpdateState>{
  if(this.downloadTask)return this.downloadTask;
  if(!this.verifier){this.state={...this.state,phase:'disabled',problem:'release_setup'};return Promise.resolve(this.status());}
  if(this.state.phase!=='available'||!this.release)return Promise.resolve(this.status());
  const release=this.release;if(release.expiresAt<=(this.options.now??Date.now)()){this.state={...this.state,phase:'failed',problem:'check_failed'};return Promise.resolve(this.status());}
  this.cancellation=new AbortController();const signal=AbortSignal.any([this.cancellation.signal,AbortSignal.timeout(10*60000)]);
  this.downloadTask=this.coordinator.run(async()=>{
   this.state={...this.state,phase:'downloading',problem:undefined,progress:0};
   this.archive=await stageDownload({directory:this.coordinator.directory,release,signal,fetcher:this.options.fetcher,progress:progress=>{this.state={...this.state,progress};},verify:async(path,r,s)=>{this.state={...this.state,phase:'verifying'};await this.verifier!(path,r,s);}});
   await this.staged();
   this.state={...this.state,phase:'ready',progress:100};return this.status();
  }).catch(error=>{
   if(this.cancellation?.signal.aborted){this.state={...this.state,phase:'available',progress:undefined,problem:undefined};}
   else{const message=error instanceof Error?error.message:'';const problem:UpdateProblem=message==='insufficient_space'?'insufficient_space':message==='verification_failed'?'verification_failed':message==='Update operation busy'?'busy':'download_failed';this.state={...this.state,phase:'failed',problem,progress:undefined};}
   return this.status();
  }).finally(()=>{this.downloadTask=undefined;this.cancellation=undefined;});return this.downloadTask;
 }
 async cancel():Promise<DesktopUpdateState>{this.cancellation?.abort();if(this.downloadTask)await this.downloadTask;return this.status();}
}
