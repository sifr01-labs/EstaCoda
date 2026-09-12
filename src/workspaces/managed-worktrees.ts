import {randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import type {ExecutionTargetBinding, ManagedGitWorktreeTarget} from '../contracts/workspace.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
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
    try{this.db.exec('create table if not exists worktree_operations (id text primary key, review_json text not null, receipt_json text not null)');}catch(error){this.close();throw error;}
  }
  private managedRoot():string{
    const profile=resolveProfileStateHome(this.input).profileRoot;
    stamp(realpathSync(profile));
    if(lstatSync(profile).isSymbolicLink())throw new Error('Profile root must not be a symlink.');
    const root=join(realpathSync(profile),'worktrees');
    try{mkdirSync(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    stamp(root);return root;
  }
  async review(source:ExecutionTargetBinding):Promise<WorktreeCreationReview>{
    const target=await this.validate(source,source.workspace.canonicalPath);
    if(target.kind!=='local')throw new Error('Select a local repository target as the source.');
    if(!await new WorkspaceTrustStore(this.input).isTrusted(target.workspace.canonicalPath))throw new Error('Trust the source repository first.');
    const repository=repositoryIdentity(target.workspace.canonicalPath);
    const baseCommit=targetGit(target.workspace.canonicalPath,['rev-parse','--verify','HEAD^{commit}']).trim();
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
  async create(review:WorktreeCreationReview,trustNewPath:boolean):Promise<ManagedGitWorktreeTarget>{
    if(trustNewPath!==true)throw new Error('Explicit trust of the new worktree path is required.');
    if(!/^[a-f0-9-]{36}$/u.test(review.operationId)||review.destination!==join(this.managedRoot(),review.operationId)||review.branch!==`estacoda/${review.operationId}`)throw new Error('Invalid managed worktree destination.');
    if(this.inspectCreation(review.operationId))throw new Error('Creation already attempted. Inspect its receipt; do not replay it.');
    const source=await this.validate(review.source,review.source.workspace.canonicalPath);
    if(source.kind!=='local'||!await new WorkspaceTrustStore(this.input).isTrusted(source.workspace.canonicalPath))throw new Error('Source is unavailable or untrusted.');
    separateRoots(source.workspace.canonicalPath,review.destination);
    checkStamp(source.workspace.canonicalPath,review.sourceDirectoryStamp);
    checkStamp(review.repository.commonDirectory,review.repository.commonDirectoryStamp);
    if(repositoryIdentity(source.workspace.canonicalPath).commonDirectory!==review.repository.commonDirectory||targetGit(source.workspace.canonicalPath,['rev-parse','--verify','HEAD^{commit}']).trim()!==review.baseCommit)throw new Error('Repository changed after review. Review creation again.');
    try{lstatSync(review.destination);throw new Error('Worktree destination already exists.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const targetId=`target_${review.operationId}`;
    this.transaction(()=>{
      const current=this.getTarget(source.id);
      if(current?.status!=='available'||current.generation!==source.generation)throw new Error('Source target changed.');
      const receipt:WorktreeCreationReceipt={operationId:review.operationId,state:'preparing',targetId};
      this.db.query('insert into worktree_operations values (?,?,?)').run(review.operationId,JSON.stringify(review),JSON.stringify(receipt));
    });
    try{
      targetGit(source.workspace.canonicalPath,['worktree','add','--no-checkout','-b',review.branch,review.destination,review.baseCommit]);
      // Local filters can execute programs during checkout. Disable every configured
      // filter (including LFS) for managed materialization; no download is implied.
      const overrides=disabledGitFilters(review.destination);
      targetGit(review.destination,[...overrides,'-c','core.sparseCheckout=false','reset','--hard',review.baseCommit]);
      const workspace=await resolveWorkspaceDirectory(review.destination);
      const gitDirectory=realpathSync(targetGit(workspace.canonicalPath,['rev-parse','--absolute-git-dir']).trim());
      const target:ManagedGitWorktreeTarget={schemaVersion:1,profileId:this.profileId,id:targetId,kind:'git-worktree',generation:1,
        source:{...source.source,identity:{...source.workspace}},workspace,status:'available',repository:review.repository,
        sourceDirectoryStamp:review.sourceDirectoryStamp,directoryStamp:stamp(workspace.canonicalPath),gitDirectory,gitDirectoryStamp:stamp(gitDirectory),
        creation:{owner:'estacoda',operationId:review.operationId,branch:review.branch,baseCommit:review.baseCommit},cleanup:'retained'};
      verifyWorktreeIdentity(target);
      this.transaction(()=>{
        const current=this.getTarget(source.id);
        if(current?.status!=='available'||current.generation!==source.generation)throw new Error('Source changed during creation.');
        this.db.query('insert into execution_targets values (?,?,?)').run(target.id,`worktree:${workspace.identityHash}`,JSON.stringify(target));
        this.db.exec('pragma user_version = 3');
      });
      await new WorkspaceTrustStore(this.input).grant(workspace.canonicalPath,{label:'Reviewed managed worktree'});
      await this.validate(targetBinding(target),workspace.canonicalPath);
      this.saveReceipt({operationId:review.operationId,state:'created',targetId});
      return target;
    }catch(error){this.saveReceipt({operationId:review.operationId,state:'attention',targetId});throw error;}
  }
  private owned(reference:{targetId:string;targetGeneration:number}):ManagedGitWorktreeTarget{
    const target=this.getTarget(reference.targetId);
    if(!target||target.kind!=='git-worktree'||target.generation!==reference.targetGeneration||target.creation.owner!=='estacoda'||target.workspace.canonicalPath!==join(this.managedRoot(),target.creation.operationId))throw new Error('Managed target is missing, stale or not owned by this profile.');
    return target;
  }
  dirty(reference:{targetId:string;targetGeneration:number}):boolean{
    const target=this.owned(reference);verifyWorktreeIdentity(target);
    return targetGit(target.workspace.canonicalPath,[...disabledGitFilters(target.workspace.canonicalPath),'status','--porcelain=v1','-z','--untracked-files=all','--ignored=matching']).length>0;
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
  async cleanup(reference:{targetId:string;targetGeneration:number}):Promise<ManagedGitWorktreeTarget>{
    const original=this.owned(reference);
    if(original.status!=='archived'||original.cleanup!=='retained')throw new Error('Archive this target before cleanup.');
    this.assertNoBorrowers(original.id);
    verifyWorktreeIdentity(original);
    if(this.dirty(reference))throw new Error('Dirty worktree retained. Commit or preserve all tracked, untracked and ignored files first.');
    const trust=new WorkspaceTrustStore(this.input);
    if(!await trust.isTrusted(original.workspace.canonicalPath)||!await trust.isTrusted(original.source.identity.canonicalPath))throw new Error('Source and worktree trust are required for cleanup.');
    return this.transaction(()=>{
      const target=this.owned(reference);
      this.assertNoBorrowers(target.id);verifyWorktreeIdentity(target);
      if(this.dirty(reference))throw new Error('Dirty worktree retained.');
      // No force removal, branch deletion, recursive fallback, or source cleanup.
      targetGit(target.source.identity.canonicalPath,[...disabledGitFilters(target.workspace.canonicalPath),'worktree','remove','--',target.workspace.canonicalPath]);
      const next={...target,cleanup:'removed' as const,generation:target.generation+1};
      this.db.query('update execution_targets set record_json=? where id=?').run(JSON.stringify(next),target.id);
      return next;
    });
  }
  private assertNoBorrowers(targetId:string):void{
    if(this.db.query<{n:number}>('select count(*) as n from target_borrowers where target_id=?').get(targetId)!.n)throw new Error('Target still has execution or inspection borrowers. Settle them before cleanup; interrupted borrowers require recovery.');
  }
  private saveReceipt(receipt:WorktreeCreationReceipt):void{
    this.transaction(()=>this.db.query('update worktree_operations set receipt_json=? where id=?').run(JSON.stringify(receipt),receipt.operationId));
  }
}
