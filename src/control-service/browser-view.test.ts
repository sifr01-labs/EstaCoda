import {it,expect} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {ExecutionTargetStore,targetBinding} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {resolveGlobalStateHome} from '../config/profile-home.js';
import {sessionWork} from './work-projections.js';
import {listBrowserViews} from './browser-view.js';
it('projects only owned bounded observations and withholds protected/private URLs',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-browser-view-'),input={homeDir,profileId:'p'},root=join(homeDir,'repo');await mkdir(root);
 const path=resolveGlobalStateHome(input).sessionsSqlitePath;await mkdir(dirname(path),{recursive:true});const db=new SQLiteSessionDB({path}),store=new ExecutionTargetStore(input);
 try{
  const target=await store.acquireLocal(root);await new WorkspaceTrustStore(input).grant(root);
  const session=await db.createSession({id:'s',profileId:'p',executionTarget:targetBinding(target)}),work=sessionWork(session,[],false);
  for(const [id,url,sensitive] of [['public','https://93.184.216.34/path?hello=world',false],['private','http://127.0.0.1/',false],['metadata','http://169.254.169.254/',false],['credential','https://user:password@93.184.216.34/',false],['protected','https://93.184.216.34/',true]] as const){
   await db.appendEvent('s',{kind:'tool-result',tool:'browser.navigate',result:{ok:true,content:'not projected',metadata:{endpoint:'ws://secret',snapshot:{sessionId:id,url,title:'Page',text:'private body',readiness:'complete',sensitiveInputActive:sensitive,identity:{documentEpoch:1,actionRevision:1,observationId:1}}}}});
  }
  const result=await listBrowserViews(input,work,new AbortController().signal);expect(result.items).toHaveLength(5);
  expect(result.items.find(item=>item.reference.browserId==='public')).toMatchObject({state:'recorded',readiness:'complete',title:'Page'});
  expect(result.items.filter(item=>item.reference.browserId!=='public').every(item=>item.state==='blocked'&&item.url===null&&item.title===null)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private body|ws:\/\/secret|password|127\.0\.0\.1|169\.254/);
  await expect(listBrowserViews({...input,profileId:'other'},work,new AbortController().signal)).rejects.toThrow();
  await expect(listBrowserViews(input,work,AbortSignal.abort())).rejects.toThrow();
 }finally{store.close();db.close();await rm(homeDir,{recursive:true,force:true});}
});
