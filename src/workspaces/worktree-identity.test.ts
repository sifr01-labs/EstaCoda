import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtemp,mkdir,rename,rm,symlink} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {ManagedWorktrees} from './managed-worktrees.js';
import {ExecutionTargetStore,targetBinding} from './execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
let homeDir:string,root:string,store:ManagedWorktrees;
const init=(path:string)=>{execFileSync('git',['init','-q',path]);execFileSync('git',['-C',path,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','Initial']);};
beforeEach(async()=>{homeDir=realpathSync(await mkdtemp('/tmp/ec-worktree-identity-'));root=join(homeDir,'repo');await mkdir(root);init(root);store=new ManagedWorktrees({homeDir,profileId:'one'});await new WorkspaceTrustStore({homeDir}).grant(root);});
afterEach(async()=>{store.close();await rm(homeDir,{recursive:true,force:true});});
const create=async()=>store.create(await store.review(targetBinding(await store.acquireLocal(root))),true);
it('rejects cross-profile handles and prevents managed roots or children from being reclassified as local',async()=>{
 const target=await create(),other=new ExecutionTargetStore({homeDir,profileId:'two'});
 try{
  await expect(other.validate(targetBinding(target),target.workspace.canonicalPath)).rejects.toThrow();
  await expect(other.acquireLocal(target.workspace.canonicalPath)).rejects.toThrow('original profile-owned target');
  const child=join(target.workspace.canonicalPath,'child');await mkdir(child);
  await expect(store.acquireLocal(child)).rejects.toThrow('original profile-owned target');
  const orphan=join(target.workspace.canonicalPath,'..','orphan');await mkdir(orphan);
  await expect(store.acquireLocal(orphan)).rejects.toThrow('original profile-owned target');
 }finally{other.close();}
});
it('rejects validation racing archive and preserves immutable Session workspace snapshots',async()=>{
 const target=await create();const db=new SQLiteSessionDB({path:join(homeDir,'sessions.sqlite')});
 try{
  await db.createSession({id:'work',profileId:'one',executionTarget:targetBinding(target)});
  const validating=store.validate(targetBinding(target),target.workspace.canonicalPath);
  const archived=store.archive({targetId:target.id,targetGeneration:1});
  await expect(validating).rejects.toThrow('changed during validation');
  const session=(await db.getSession('work'))!;expect(session.executionTarget).toEqual(targetBinding(target));expect(session.metadata?.workspaceRoot).toBe(target.workspace.canonicalPath);
  expect(archived.generation).toBe(2);expect(archived.source).toEqual(target.source);
  expect(()=>store.archive({targetId:target.id,targetGeneration:1})).toThrow('stale');
 }finally{db.close();}
});
it('detects replaced worktree roots and symlink redirection without following them for cleanup',async()=>{
 const target=await create(),path=target.workspace.canonicalPath;await rename(path,path+'-saved');await symlink(path+'-saved',path);
 await expect(store.validate(targetBinding(target),path)).rejects.toThrow();
 const archived=store.archive({targetId:target.id,targetGeneration:1});
 await expect(store.cleanup({targetId:target.id,targetGeneration:archived.generation})).rejects.toThrow();
 await rm(path);await mkdir(path);await expect(store.validate(targetBinding({...target,status:'available'}),path)).rejects.toThrow();
 expect(store.getTarget(target.id)!.workspace.canonicalPath).toBe(path);
});
it('rejects a repository replaced at the same path',async()=>{
 const target=await create();await rename(join(root,'.git'),join(root,'.git-saved'));init(root);
 await expect(store.validate(targetBinding(target),target.workspace.canonicalPath)).rejects.toThrow('replaced');
});
it('alias rename and move never retarget the worktree source or historical Work',async()=>{
 const registered=await store.add('source',root);const source=await store.acquireLocal(root,{identity:registered.identity,registeredWorkspaceId:registered.id,registeredWorkspaceRevision:registered.locationRevision});
 const target=await store.create(await store.review(targetBinding(source)),true);
 store.rename('source','renamed');const other=join(homeDir,'other');await mkdir(other);init(other);await store.move(registered.id,other,1);
 const current=await store.validate(targetBinding(target),target.workspace.canonicalPath);
 expect(current.source.identity.canonicalPath).toBe(root);expect(current.workspace.canonicalPath).toBe(target.workspace.canonicalPath);
});
