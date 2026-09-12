import {randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, realpathSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import type {ExecutionTargetBinding, ManagedGitWorktreeTarget} from '../contracts/workspace.js';
import {resolveProfileStateHome,resolveGlobalStateHome} from '../config/profile-home.js';
import {withProfileWriteLock} from '../config/profile-write-lock.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {ExecutionTargetStore, targetBinding} from './execution-target.js';
import {resolveWorkspaceDirectory} from './workspace-registry.js';
import {checkStamp, stamp, separateRoots} from './copy-files.js';
import {repositoryIdentity, targetGit, verifyWorktreeIdentity, disabledGitFilters} from './git-worktree-identity.js';

export type WorktreeCreationReview = {
  operationId:string; source:ExecutionTargetBinding; destination:string; branch:string; baseCommit:string;
  repository:ManagedGitWorktreeTarget['repository']; sourceDirectoryStamp:{dev:number;ino:number};
};
export type WorktreeCreationReceipt = {operationId:string;state:'preparing'|'created'|'attention';targetId:string};

/** Core owns both provenance and recovery. Interrupted effects are never replayed. */
export class ManagedWorktrees extends ExecutionTargetStore {
  constructor(private readonly input:{homeDir:string;profileId:string}){
    super(input);
    try{this.db.exec('create table if not exists worktree_operations (id text primary key, review_json text not null, receipt_json text not null); create table if not exists target_operations (id text primary key, request_json text not null, receipt_json text not null)');}catch(error){this.close();throw error;}
  }
  private managedRoot():string{
    const profile=resolveProfileStateHome(this.input).profileRoot;
    stamp(realpathSync(profile));
    if(lstatSync(profile).isSymbolicLink())throw new Error('Profile root must not be a symlink.');
    const paths=resolveGlobalStateHome(this.input);
    const parent=join(realpathSync(dirname(paths.worktreesRoot)),basename(paths.worktreesRoot));
    try{mkdirSync(parent,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}stamp(parent);
    const root=join(parent,this.profileId);
    try{mkdirSync(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    stamp(root);return root;
  }
  async review(source:ExecutionTargetBinding,signal?:AbortSignal):Promise<WorktreeCreationReview>{
    const target=await this.validate(source,source.workspace.canonicalPath,signal);
    if(target.kind!=='local')throw new Error('Select a local repository target as the source.');
    if(!await new WorkspaceTrustStore(this.input).isTrusted(target.workspace.canonicalPath))throw new Error('Trust the source repository first.');
    const repository=await repositoryIdentity(target.workspace.canonicalPath,signal);
    const baseCommit=(await targetGit(target.workspace.canonicalPath,['rev-parse','--verify','HEAD^{commit}'],signal)).trim();
    if(!/^[a-f0-9]{40,64}$/u.test(baseCommit))throw new Error('Repository needs a committed HEAD.');
    const operationId=randomUUID();
    const destination=join(this.managedRoot(),operationId);
    separateRoots(target.workspace.canonicalPath,destination);
    return {operationId,source:targetBinding(target),destination,branch:`estacoda/${operationId}`,baseCommit,repository,sourceDirectoryStamp:stamp(target.workspace.canonicalPath)};
  }
  inspectCreation(operationId:string):WorktreeCreationReceipt|undefined{
    const row=this.db.query<{receipt_json:string}>('select receipt_json from worktree_operations where id=?').get(operationId);
    return row?JSON.parse(row.receipt_json) as WorktreeCreationReceipt:undefined;
  }
  async create(review:WorktreeCreationReview,trustNewPath:boolean,signal?:AbortSignal):Promise<ManagedGitWorktreeTarget>{
    if(trustNewPath!==true)throw new Error('Explicit trust of the new worktree path is required.');
    if(!/^[a-f0-9-]{36}$/u.test(review.operationId)||review.destination!==join(this.managedRoot(),review.operationId)||review.branch!==`estacoda/${review.operationId}`)throw new Error('Invalid managed worktree destination.');
    if(this.inspectOperation(review.operationId).state!=='unknown')throw new Error('Creation already attempted. Inspect its receipt; do not replay it.');
    const source=await this.validate(review.source,review.source.workspace.canonicalPath,signal);
    if(source.kind!=='local'||!await new WorkspaceTrustStore(this.input).isTrusted(source.workspace.canonicalPath))throw new Error('Source is unavailable or untrusted.');
    separateRoots(source.workspace.canonicalPath,review.destination);
    checkStamp(source.workspace.canonicalPath,review.sourceDirectoryStamp);
    checkStamp(review.repository.commonDirectory,review.repository.commonDirectoryStamp);
    if((await repositoryIdentity(source.workspace.canonicalPath,signal)).commonDirectory!==review.repository.commonDirectory||(await targetGit(source.workspace.canonicalPath,['rev-parse','--verify','HEAD^{commit}'],signal)).trim()!==review.baseCommit)throw new Error('Repository changed after review. Review creation again.');
    try{lstatSync(review.destination);throw new Error('Worktree destination already exists.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const targetId=`target_${review.operationId}`;
    this.transaction(()=>{
      const current=this.getTarget(source.id);
      if(current?.status!=='available'||current.generation!==source.generation)throw new Error('Source target changed.');
      if(this.db.query<{n:number}>('select count(*) as n from worktree_operations').get()!.n>=1000)throw new Error('Creation history is full.');
      const receipt:WorktreeCreationReceipt={operationId:review.operationId,state:'preparing',targetId};
      this.db.query('insert into worktree_operations values (?,?,?)').run(review.operationId,JSON.stringify(review),JSON.stringify(receipt));
    });
    try{
      await targetGit(source.workspace.canonicalPath,['worktree','add','--no-checkout','-b',review.branch,review.destination,review.baseCommit],signal);
      if((await repositoryIdentity(review.destination,signal)).commonDirectory!==review.repository.commonDirectory)throw new Error('Created worktree belongs to a different repository.');
      // Local filters can execute programs during checkout. Disable every configured
      // filter (including LFS) for managed materialization; no download is implied.
      const overrides=await disabledGitFilters(review.destination,signal);
      await targetGit(review.destination,[...overrides,'-c','core.sparseCheckout=false','reset','--hard',review.baseCommit],signal);
      const workspace=await resolveWorkspaceDirectory(review.destination);
      const gitDirectory=realpathSync((await targetGit(workspace.canonicalPath,['rev-parse','--absolute-git-dir'],signal)).trim());
      const target:ManagedGitWorktreeTarget={schemaVersion:1,profileId:this.profileId,id:targetId,kind:'git-worktree',generation:1,
        source:{...source.source,identity:{...source.workspace}},workspace,status:'available',repository:review.repository,
        sourceDirectoryStamp:review.sourceDirectoryStamp,directoryStamp:stamp(workspace.canonicalPath),gitDirectory,gitDirectoryStamp:stamp(gitDirectory),
        creation:{owner:'estacoda',operationId:review.operationId,branch:review.branch,baseCommit:review.baseCommit},cleanup:'retained'};
      await verifyWorktreeIdentity(target,signal);
      this.transaction(()=>{
        const current=this.getTarget(source.id);
        if(current?.status!=='available'||current.generation!==source.generation)throw new Error('Source changed during creation.');
        this.db.query('insert into execution_targets values (?,?,?)').run(target.id,`worktree:${workspace.identityHash}`,JSON.stringify(target));
        this.db.exec('pragma user_version = 3');
      });
      await new WorkspaceTrustStore(this.input).grant(workspace.canonicalPath,{label:'Reviewed managed worktree'});
      await this.validate(targetBinding(target),workspace.canonicalPath,signal);
      this.saveReceipt({operationId:review.operationId,state:'created',targetId});
      return target;
    }catch(error){this.saveReceipt({operationId:review.operationId,state:'attention',targetId});throw error;}
  }
  borrowers(targetId:string):number{
    if(!this.getTarget(targetId))throw new Error('Target not found.');
    return this.db.query<{n:number}>('select count(*) as n from target_borrowers where target_id=?').get(targetId)!.n;
  }
  inspectOperation(operationId:string):import('../contracts/workspace.js').TargetOperationReceipt{
    const row=this.db.query<{receipt_json:string}>('select receipt_json from target_operations where id=?').get(operationId);
    if(row)return JSON.parse(row.receipt_json);
    const creation=this.inspectCreation(operationId);
    const target=creation?this.getTarget(creation.targetId):undefined;
    return {operationId,action:creation?'create':'unknown',state:creation?.state==='created'?'completed':creation?'uncertain':'unknown',target:target?{targetId:target.id,targetGeneration:target.generation}:null};
  }
  async executeLifecycle(operationId:string,action:'archive'|'cleanup',reference:{targetId:string;targetGeneration:number},signal?:AbortSignal):Promise<import('../contracts/workspace.js').TargetOperationReceipt>{
    if(!/^[a-f0-9-]{36}$/u.test(operationId))throw new Error('Invalid operation identity.');
    const request=JSON.stringify({action,reference});
    const reserved=this.transaction(()=>{
      const old=this.db.query<{request_json:string}>('select request_json from target_operations where id=?').get(operationId);
      if(old){if(old.request_json!==request)throw new Error('Operation binding changed.');return false;}
      if(this.inspectCreation(operationId))throw new Error('Operation identity already used.');
      this.owned(reference);
      if(this.db.query<{n:number}>('select count(*) as n from target_operations').get()!.n>=1000)throw new Error('Operation history is full.');
      this.db.query('insert into target_operations values (?,?,?)').run(operationId,request,JSON.stringify({operationId,action,state:'uncertain',target:reference}));return true;
    });
    if(!reserved)return this.inspectOperation(operationId);
    // A failed external effect remains uncertain. Inspect state, never auto-replay.
    try{
      const target=action==='archive'?this.archive(reference):await this.cleanup(reference,signal);
      const receipt={operationId,action,state:'completed',target:{targetId:target.id,targetGeneration:target.generation}};
      this.transaction(()=>this.db.query('update target_operations set receipt_json=? where id=?').run(JSON.stringify(receipt),operationId));
    }catch{/* Retain the reserved receipt. */}
    return this.inspectOperation(operationId);
  }
  private owned(reference:{targetId:string;targetGeneration:number}):ManagedGitWorktreeTarget{
    const target=this.getTarget(reference.targetId);
    if(!target||target.kind!=='git-worktree'||target.generation!==reference.targetGeneration||target.creation.owner!=='estacoda'||target.workspace.canonicalPath!==join(this.managedRoot(),target.creation.operationId))throw new Error('Managed target is missing, stale or not owned by this profile.');
    return target;
  }
  async dirty(reference:{targetId:string;targetGeneration:number},signal?:AbortSignal):Promise<boolean>{
    const target=this.owned(reference);await verifyWorktreeIdentity(target,signal);
    return (await targetGit(target.workspace.canonicalPath,[...await disabledGitFilters(target.workspace.canonicalPath,signal),'status','--porcelain=v1','-z','--untracked-files=all','--ignored=matching'],signal)).length>0;
  }
  archive(reference:{targetId:string;targetGeneration:number}):ManagedGitWorktreeTarget{
    return this.transaction(()=>{
      const target=this.owned(reference);
      if(target.status!=='available')throw new Error('Target is already archived.');
      // Archive is a metadata fence even if the backing path has gone missing.
      const next={...target,status:'archived' as const,generation:target.generation+1};
      this.db.query('update execution_targets set record_json=? where id=?').run(JSON.stringify(next),target.id);
      return next;
    });
  }
  async cleanup(reference:{targetId:string;targetGeneration:number},signal?:AbortSignal):Promise<ManagedGitWorktreeTarget>{
    // Archived targets cannot acquire new borrowers. Serialize cleanup across processes
    // without holding a synchronous workspace DB transaction while awaiting Git.
    return withProfileWriteLock(resolveProfileStateHome(this.input).profileRoot,async()=>{
      signal?.throwIfAborted();
      const target=this.owned(reference);
      if(target.status!=='archived'||target.cleanup!=='retained')throw new Error('Archive this target before cleanup.');
      this.assertNoBorrowers(target.id);
      if(await this.dirty(reference,signal))throw new Error('Dirty worktree retained. Commit or preserve all tracked, untracked and ignored files first.');
      const trust=new WorkspaceTrustStore(this.input);
      await verifyWorktreeIdentity(target,signal);
      const overrides=await disabledGitFilters(target.workspace.canonicalPath,signal);
      if(await this.dirty(reference,signal))throw new Error('Dirty worktree retained.');
      if(!await trust.isTrusted(target.workspace.canonicalPath)||!await trust.isTrusted(target.source.identity.canonicalPath))throw new Error('Source and worktree trust are required for cleanup.');
      this.owned(reference);this.assertNoBorrowers(target.id);
      // Git rechecks dirtiness itself. No force, branch deletion or recursive fallback.
      await targetGit(target.source.identity.canonicalPath,[...overrides,'worktree','remove','--',target.workspace.canonicalPath],signal);
      return this.transaction(()=>{
        this.owned(reference);this.assertNoBorrowers(target.id);
        const next={...target,cleanup:'removed' as const,generation:target.generation+1};
        this.db.query('update execution_targets set record_json=? where id=?').run(JSON.stringify(next),target.id);
        return next;
      });
    });
  }
  private assertNoBorrowers(targetId:string):void{
    if(this.db.query<{n:number}>('select count(*) as n from target_borrowers where target_id=?').get(targetId)!.n)throw new Error('Target still has execution or inspection borrowers. Settle them before cleanup; interrupted borrowers require recovery.');
  }
  private saveReceipt(receipt:WorktreeCreationReceipt):void{
    this.transaction(()=>this.db.query('update worktree_operations set receipt_json=? where id=?').run(JSON.stringify(receipt),receipt.operationId));
  }
}
