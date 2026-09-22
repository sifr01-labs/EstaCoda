import {join} from 'node:path';
import type {DesktopUpdateState} from '../../shared/desktop-updates.js';
import {UpdateDownloads} from './download-controller.js';
import type {DiscoveryOptions} from './discovery.js';
import {UpdateCoordinator} from './coordinator.js';
import {UpdateLocalState} from './local-state.js';
import {verifyArchiveBytes,type ArchiveVerifier} from './download.js';
import {verifiedRelease,compatibleRelease,newerVersion,type DesktopRelease} from './release-feed.js';
import {restartBlock,type RestartEvidence} from './restart-gate.js';
/** Implement with an accepted native updater only after real signed N→N+1 proof.
 * The adapter must hold runtime/reader lifecycle guards through replacement. */
export type PlatformInstaller={restartEvidence():Promise<RestartEvidence>;install(archive:string,release:DesktopRelease):Promise<void>;verifyRunning(release:DesktopRelease):Promise<void>};
type Receipt={format:1;phase:'staged'|'replacement_requested'|'installed'|'uncertain';metadata:string;baseVersion:string};
export class UpdateInstaller extends UpdateDownloads {
 private readonly receipts:UpdateLocalState;private installing?:Promise<DesktopUpdateState>;
 constructor(options:DiscoveryOptions,coordinator:UpdateCoordinator,verifier?:ArchiveVerifier,private readonly platform?:PlatformInstaller){super(options,coordinator,verifier);this.receipts=new UpdateLocalState(coordinator.directory);}
 private receipt(phase:Receipt['phase']):void {
  if(!this.authenticatedMetadata)throw Error('Missing authenticated metadata');
  this.receipts.write('receipt.json',{format:1,phase,metadata:this.authenticatedMetadata,baseVersion:this.options.version} satisfies Receipt);
 }
 protected override async staged():Promise<void>{this.receipt('staged');}
 async restore():Promise<DesktopUpdateState>{
  if(!this.verifier||!this.platform||!this.options.publicKey||!this.options.teamId)return this.status();
  return this.coordinator.run(()=>this.restoreLocked()).catch(()=>{this.state={...this.state,phase:'failed',problem:'busy'};return this.status();});
 }
 private async restoreLocked():Promise<DesktopUpdateState>{
  if(!this.verifier||!this.platform||!this.options.publicKey||!this.options.teamId)return this.status();
  const value=this.receipts.read('receipt.json') as Receipt|null;if(!value)return this.status();
  try{
   if(value.format!==1||!['staged','replacement_requested','installed','uncertain'].includes(value.phase)||typeof value.metadata!=='string'||typeof value.baseVersion!=='string')throw Error('Invalid update receipt');
   const release=verifiedRelease(Buffer.from(value.metadata),{publicKey:this.options.publicKey,teamId:this.options.teamId,now:(this.options.now??Date.now)(),allowExpiredReceipt:true});
   if(!compatibleRelease(release,this.options))throw Error('Incompatible receipt');
   this.release=release;this.authenticatedMetadata=value.metadata;
   if(this.options.version===release.version&&['replacement_requested','installed'].includes(value.phase)){
    await this.platform.verifyRunning(release);this.receipt('installed');this.state={...this.state,phase:'installed',problem:undefined};
   }else if(value.phase==='staged'&&value.baseVersion===this.options.version&&release.expiresAt>(this.options.now??Date.now)()&&newerVersion(release.version,this.options.version)){
    this.archive=join(this.coordinator.directory,release.updater.sha256+'.zip');const signal=AbortSignal.timeout(120000);
    await verifyArchiveBytes(this.archive,release,signal);await this.verifier(this.archive,release,signal);
    this.state={...this.state,phase:'ready',availableVersion:release.version,notesUrl:release.notesUrl,progress:100,problem:undefined};
   }else throw Error('Replacement outcome uncertain');
  }catch{this.state={...this.state,phase:'failed',problem:'recovery_required'};}
  return this.status();
 }
 install():Promise<DesktopUpdateState>{
  if(this.installing)return this.installing;
  if(!this.platform||!this.verifier){this.state={...this.state,phase:'disabled',problem:'release_setup'};return Promise.resolve(this.status());}
  if(this.state.phase!=='ready'||!this.release||!this.archive)return Promise.resolve(this.status());
  const release=this.release,archive=this.archive;
  this.installing=this.coordinator.run(async()=>{
   if(!this.status().installation.canReplace)throw Error('restart_blocked');
   if(release.expiresAt<=(this.options.now??Date.now)()||!compatibleRelease(release,this.options)||!newerVersion(release.version,this.options.version))throw Error('incompatible');
   const signal=AbortSignal.timeout(120000);await verifyArchiveBytes(archive,release,signal);await this.verifier!(archive,release,signal);
   const blocked=restartBlock(await this.platform!.restartEvidence());if(blocked)throw Error(blocked);
   await verifyArchiveBytes(archive,release,signal);
   if(!this.status().installation.canReplace)throw Error('restart_blocked');
   this.receipt('replacement_requested');this.state={...this.state,phase:'installing',problem:undefined};
   try{await this.platform!.install(archive,release);}catch{this.receipt('uncertain');throw Error('recovery_required');}
   // Only a subsequent verified app launch may record installed.
   return this.status();
  }).catch(error=>{const message=error instanceof Error?error.message:'';this.state={...this.state,phase:'failed',problem:message==='incompatible'?'incompatible':message==='active_runtime'?'active_runtime':message==='restart_blocked'?'restart_blocked':message==='Update operation busy'?'busy':'recovery_required'};return this.status();}).finally(()=>{this.installing=undefined;});return this.installing;
 }
}
