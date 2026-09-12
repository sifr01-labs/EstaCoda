import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {ManagedWorktrees} from './managed-worktrees.js';
import {targetBinding} from './execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
let homeDir:string,root:string,store:ManagedWorktrees;
const git=(args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
beforeEach(async()=>{homeDir=realpathSync(await mkdtemp('/tmp/ec-worktree-safety-'));root=join(homeDir,'repo');await mkdir(root);git(['init','-q']);await writeFile(join(root,'tracked'),'baseline');git(['add','tracked']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','Initial']);store=new ManagedWorktrees({homeDir,profileId:'p'});await new WorkspaceTrustStore({homeDir}).grant(root);});
afterEach(async()=>{store.close();await rm(homeDir,{recursive:true,force:true});});
const review=async()=>store.review(targetBinding(await store.acquireLocal(root)));
it.each(['tracked','staged','untracked','ignored'])('preserves %s changes on cleanup',async(kind)=>{
 const target=await store.create(await review(),true),path=target.workspace.canonicalPath;
 const file=kind==='tracked'||kind==='staged'?'tracked':kind;
 if(kind==='ignored')await writeFile(join(root,'.git/info/exclude'),'ignored\n');
 await writeFile(join(path,file),'valuable');if(kind==='staged')execFileSync('git',['-C',path,'add','tracked']);
 const archived=store.archive({targetId:target.id,targetGeneration:1});
 await expect(store.cleanup({targetId:target.id,targetGeneration:archived.generation})).rejects.toThrow('Dirty');
 expect(await readFile(join(path,file),'utf8')).toBe('valuable');expect(await readFile(join(root,'tracked'),'utf8')).toBe('baseline');
});
it('does not force-remove a locked worktree or erase its branch',async()=>{
 const target=await store.create(await review(),true);git(['worktree','lock',target.workspace.canonicalPath]);
 const archived=store.archive({targetId:target.id,targetGeneration:1});
 await expect(store.cleanup({targetId:target.id,targetGeneration:archived.generation})).rejects.toThrow();
 expect((await stat(target.workspace.canonicalPath)).isDirectory()).toBe(true);expect(git(['branch','--list',target.creation.branch])).toContain(target.creation.branch);
});
it('requires current source trust at creation and current source and worktree trust at cleanup',async()=>{
 const draft=await review(),trust=new WorkspaceTrustStore({homeDir});await trust.revoke(root);
 await expect(store.create(draft,true)).rejects.toThrow('untrusted');await trust.grant(root);
 const target=await store.create(draft,true),archived=store.archive({targetId:target.id,targetGeneration:1});await trust.revoke(target.workspace.canonicalPath);
 await expect(store.cleanup({targetId:target.id,targetGeneration:archived.generation})).rejects.toThrow('trust');
});
it('reserves creation once across competing store connections',async()=>{
 const draft=await review(),other=new ManagedWorktrees({homeDir,profileId:'p'});
 try{const outcomes=await Promise.allSettled([store.create(draft,true),other.create(draft,true)]);expect(outcomes.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(store.listTargets().filter(item=>item.kind==='git-worktree')).toHaveLength(1);expect(store.inspectCreation(draft.operationId)?.state).toBe('created');}finally{other.close();}
});
it('retains an interrupted cross-process borrower instead of assuming its subprocesses are gone',async()=>{
 const target=await store.create(await review(),true);
 const script=`import {ExecutionTargetStore} from ${JSON.stringify(new URL('./execution-target.ts',import.meta.url).href)};const store=new ExecutionTargetStore(${JSON.stringify({homeDir,profileId:'p'})});await store.borrow(${JSON.stringify(targetBinding(target))});process.exit(0);`;
 await promisify(execFile)(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',script],{timeout:15000});
 expect(store.borrowers(target.id)).toBe(1);const archived=store.archive({targetId:target.id,targetGeneration:1});
 await expect(store.cleanup({targetId:target.id,targetGeneration:archived.generation})).rejects.toThrow('interrupted borrowers require recovery');
});
it('an interrupted creation journal blocks duplicate Git effects after restart',async()=>{
 const draft=await review();
 const script=`import {ManagedWorktrees} from ${JSON.stringify(new URL('./managed-worktrees.ts',import.meta.url).href)};const store=new ManagedWorktrees(${JSON.stringify({homeDir,profileId:'p'})});const review=${JSON.stringify(draft)};store.db.query('insert into worktree_operations values (?,?,?)').run(review.operationId,JSON.stringify(review),JSON.stringify({operationId:review.operationId,state:'preparing',targetId:'target_'+review.operationId}));process.exit(0);`;
 await promisify(execFile)(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',script],{timeout:15000});
 await expect(store.create(draft,true)).rejects.toThrow('already attempted');
 expect(store.inspectOperation(draft.operationId)).toMatchObject({state:'uncertain'});await expect(stat(draft.destination)).rejects.toMatchObject({code:'ENOENT'});
});
it('keeps working files outside protected runtime state without weakening Docker mount admission',async()=>{
 const {assertSafeDockerWorkspace}=await import('../execution/docker-container.js');
 const target=await store.create(await review(),true);
 expect(target.workspace.canonicalPath).toBe(join(homeDir,'.estacoda-worktrees','p',target.creation.operationId));
 await expect(assertSafeDockerWorkspace(target.workspace.canonicalPath,homeDir)).resolves.toBeUndefined();
 await expect(assertSafeDockerWorkspace(join(homeDir,'.estacoda'),homeDir)).rejects.toThrow('protected');
});
it('preserves explicit trust for two independently created worktrees',async()=>{
 const drafts=await Promise.all([review(),review()]),other=new ManagedWorktrees({homeDir,profileId:'p'});
 try{const targets=await Promise.all([store.create(drafts[0]!,true),other.create(drafts[1]!,true)]);for(const target of targets)expect(await new WorkspaceTrustStore({homeDir}).isTrusted(target.workspace.canonicalPath)).toBe(true);}finally{other.close();}
});
