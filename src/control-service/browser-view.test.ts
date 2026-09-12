import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {ExecutionTargetStore,targetBinding} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../config/profile-home.js';
import {sessionWork} from './work-projections.js';
import * as urlSafety from '../browser/url-safety.js';
import {listBrowserViews} from './browser-view.js';
it('projects only owned bounded observations and withholds protected/private URLs',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-browser-view-'),input={homeDir,profileId:'p'},root=join(homeDir,'repo');await mkdir(root);
 const path=resolveGlobalStateHome(input).sessionsSqlitePath;await mkdir(dirname(path),{recursive:true});const db=new SQLiteSessionDB({path}),store=new ExecutionTargetStore(input);
 try{
  const target=await store.acquireLocal(root);await new WorkspaceTrustStore(input).grant(root);
  const session=await db.createSession({id:'s',profileId:'p',executionTarget:targetBinding(target)}),work=sessionWork(session,[],false);
  for(const [id,url,sensitive] of [['public','https://93.184.216.34/path?hello=world',false],['private','http://127.0.0.1/',false],['metadata','http://169.254.169.254/',false],['credential','https://user:password@93.184.216.34/',false],['protected','https://93.184.216.34/',true],['token','https://93.184.216.34/?access_token=secret',false],['scheme','file:///private/secret',false]] as const){
   await db.appendEvent('s',{kind:'tool-result',tool:'browser.navigate',result:{ok:true,content:'not projected',metadata:{endpoint:'ws://secret',snapshot:{sessionId:id,url,title:'Page',text:'private body',readiness:'complete',sensitiveInputActive:sensitive,identity:{documentEpoch:1,actionRevision:1,observationId:1}}}}});
  }
  const result=await listBrowserViews(input,work,new AbortController().signal);expect(result.items).toHaveLength(7);
  expect(result.items.find(item=>item.reference.browserId==='public')).toMatchObject({state:'recorded',readiness:'complete',title:'Page'});
  expect(result.items.filter(item=>item.reference.browserId!=='public').every(item=>item.state==='blocked'&&item.url===null&&item.title===null)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private body|ws:\/\/secret|password|127\.0\.0\.1|169\.254/);
  await expect(listBrowserViews({...input,profileId:'other'},work,new AbortController().signal)).rejects.toThrow();
  await expect(listBrowserViews(input,work,AbortSignal.abort())).rejects.toThrow();
  const configPath=resolveProfileStateHome(input).configPath;await mkdir(dirname(configPath),{recursive:true});
  await writeFile(configPath,JSON.stringify({security:{allowPrivateUrls:true,websiteBlocklist:{domains:['93.184.216.34']}}}));
  const changed=await listBrowserViews(input,work,new AbortController().signal);
  expect(changed.items.find(item=>item.reference.browserId==='private')?.state).toBe('recorded');
  expect(changed.items.find(item=>item.reference.browserId==='public')?.state).toBe('blocked');
  expect(changed.items.find(item=>item.reference.browserId==='metadata')?.state).toBe('blocked');
  await new WorkspaceTrustStore(input).revoke(root);
  await expect(listBrowserViews(input,work,new AbortController().signal)).rejects.toThrow('trust');

 }finally{store.close();db.close();await rm(homeDir,{recursive:true,force:true});}
});

it('bounds browser history and never borrows a same-named browser from another profile',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-browser-limits-'),input={homeDir,profileId:'p'},root=join(homeDir,'repo');await mkdir(root);
 const path=resolveGlobalStateHome(input).sessionsSqlitePath;await mkdir(dirname(path),{recursive:true});const db=new SQLiteSessionDB({path}),store=new ExecutionTargetStore(input);
 try{
  const target=await store.acquireLocal(root);await new WorkspaceTrustStore(input).grant(root);
  const session=await db.createSession({id:'s',profileId:'p',executionTarget:targetBinding(target)}),work=sessionWork(session,[],false),signal=new AbortController().signal;
  await db.createSession({id:'foreign',profileId:'other',executionTarget:targetBinding(target)});
  const event=(id:string,title:string)=>({kind:'tool-result' as const,tool:'browser.snapshot',result:{ok:true,content:'Observed',metadata:{snapshot:{sessionId:id,url:'https://93.184.216.34/',title}}}});
  await db.appendEvent('foreign',event('b','Foreign profile title'));
  expect((await listBrowserViews(input,work,signal)).items).toEqual([]);
  for(let i=0;i<70;i++)await db.appendEvent('s',event('b'+i,'Page '+i));
  const result=await listBrowserViews(input,work,signal);expect(result.truncated).toBe(true);expect(result.items).toHaveLength(8);expect(result.items[0]!.reference.browserId).toBe('b69');expect(JSON.stringify(result)).not.toContain('Foreign profile title');
  const checks:Array<(allowed:boolean)=>void>=[],guard=vi.spyOn(urlSafety,'isSafeUrl').mockImplementation(()=>new Promise(resolve=>checks.push(resolve)));
  try{const pending=listBrowserViews(input,work,signal);await vi.waitFor(()=>expect(checks).toHaveLength(8));for(const resolve of checks)resolve(false);expect((await pending).items.every(item=>item.state==='blocked')).toBe(true);}finally{for(const resolve of checks)resolve(false);guard.mockRestore();}
  for(let i=0;i<65;i++)await db.appendEvent('s',event('oversized','x'.repeat(66000)));
  const oversized=await listBrowserViews(input,work,signal);expect(oversized.items).toEqual([]);expect(oversized.truncated).toBe(true);
  await expect(listBrowserViews(input,{...work,canonicalId:'foreign'},signal)).rejects.toThrow();
 }finally{store.close();db.close();await rm(homeDir,{recursive:true,force:true});}
});
