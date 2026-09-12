import {it,expect} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import sharp from 'sharp';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {ExecutionTargetStore,targetBinding} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../config/profile-home.js';
import {ArtifactStore} from '../artifacts/artifact-store.js';
import {createWebTools} from '../tools/web-tools.js';
import {createMockBrowserBackend} from '../browser/browser-backend.js';
import {sessionWork} from './work-projections.js';
import {listBrowserViews} from './browser-view.js';
import {browserViewSnapshot} from './browser-snapshot.js';
import {CONTROL_METHODS,CONTROL_EVENTS,validateControlResponse,serializeControlFrame} from '../contracts/desktop-control/index.js';
it('retains sanitized tool captures, verifies them on read and fences stale observations',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-browser-image-'),input={homeDir,profileId:'p'},root=join(homeDir,'repo');await mkdir(root);
 const path=resolveGlobalStateHome(input).sessionsSqlitePath;await mkdir(dirname(path),{recursive:true});const db=new SQLiteSessionDB({path}),store=new ExecutionTargetStore(input);
 try{
  const target=await store.acquireLocal(root);await new WorkspaceTrustStore(input).grant(root);
  const session=await db.createSession({id:'s',profileId:'p',executionTarget:targetBinding(target)}),work=sessionWork(session,[],false),signal=new AbortController().signal;
  const identity={documentEpoch:1,actionRevision:1,observationId:1};
  const event={kind:'tool-result' as const,tool:'browser.snapshot',result:{ok:true,content:'Observed',metadata:{snapshot:{sessionId:'b',url:'https://93.184.216.34/',title:'Page',identity,tab:{ref:'t'},observedAt:new Date().toISOString()}}}};
  await db.appendEvent('s',event);
  const reference=(await listBrowserViews(input,work,signal)).items[0]!.reference;
  const png=await sharp({create:{width:1200,height:800,channels:3,background:'#147dab'}}).png().toBuffer();
  const artifacts=new ArtifactStore({storageRoot:join(resolveProfileStateHome(input).profileRoot,'artifacts')});
  const backend={...createMockBrowserBackend(),screenshot:async()=>({mimeType:'image/png' as const,base64:png.toString('base64'),observation:{screenshotId:'shot',sessionId:'b',tabRef:'t',identity,captureScope:'viewport' as const,sanitized:true as const,maskedRegionCount:0,viewport:{cssWidth:1200,cssHeight:800,pixelWidth:1200,pixelHeight:800}}})};
  const tool=createWebTools({workspaceRoot:root,browserBackend:backend,artifactStore:artifacts,currentSessionId:()=>session.id,profileId:'p',persistSessionArtifact:async(owner,artifact)=>db.appendEvent(owner,{kind:'session-artifact-registered',artifact})}).find(tool=>tool.name==='browser.screenshot')!;
  const result=await tool.run({sessionId:'b'});expect(result.ok).toBe(true);expect(await import('node:fs/promises').then(fs=>fs.readFile(result.metadata!.path as string))).toEqual(png);expect(result.metadata?.artifactId).toBeTypeOf('string');
  await db.appendEvent('s',{kind:'tool-result',tool:'browser.screenshot',result});
  const preview=await browserViewSnapshot(input,work,reference,signal);expect(preview.image?.mimeType).toBe('image/jpeg');expect(preview.image!.base64.length).toBeLessThanOrEqual(60000);
  const request={jsonrpc:'2.0' as const,id:'snapshot',method:'browser.snapshot' as const,params:{workId:work.id,reference}},response={jsonrpc:'2.0' as const,id:'snapshot',result:preview};
  expect(()=>validateControlResponse(response,request,{profileId:'p',instanceId:'b',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}})).not.toThrow();expect(()=>serializeControlFrame(response as never)).not.toThrow();
  const retained=artifacts.get(result.metadata!.artifactId as string,{profileId:'p',sessionId:'s'})!;await writeFile(retained.localPath!,'tampered');
  expect((await browserViewSnapshot(input,work,reference,signal)).image).toBeNull();
  await db.appendEvent('s',event);await expect(browserViewSnapshot(input,work,reference,signal)).rejects.toThrow('changed');
 }finally{store.close();db.close();await rm(homeDir,{recursive:true,force:true});}
});
