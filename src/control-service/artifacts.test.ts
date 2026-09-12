import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../config/profile-home.js';
import {ArtifactStore} from '../artifacts/artifact-store.js';
import {listArtifacts,inspectArtifact} from './artifacts.js';
import {workEvidence} from './evidence.js';
import {sessionWork} from './work-projections.js';
it('projects durable artifacts and current-turn evidence with profile isolation',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-desktop-artifacts-'),input={homeDir,profileId:'p'},signal=new AbortController().signal,path=resolveGlobalStateHome(input).sessionsSqlitePath;
 await mkdir(dirname(path),{recursive:true});const db=new SQLiteSessionDB({path});
 try{
  const session=await db.createSession({id:'s',profileId:'p'}),work=sessionWork(session,[],false);
  const root=join(resolveProfileStateHome(input).profileRoot,'artifacts'),capture=join(homeDir,'capture.txt'),content='A retained report';await writeFile(capture,content);
  const retained=await new ArtifactStore({storageRoot:root}).retainSessionArtifact({sessionId:'s',profileId:'p',capturePath:capture,kind:'document',bytes:Buffer.byteLength(content),mimeType:'text/plain',sha256:createHash('sha256').update(content).digest('hex'),source:{kind:'browser.download',filename:'report.txt',description:'Report',origin:'https://example.com'},persist:async artifact=>db.appendEvent('s',{kind:'session-artifact-registered',artifact})});
  const page=await listArtifacts(input,{},signal);expect(page.items).toHaveLength(1);expect(JSON.stringify(page)).not.toContain(root);
  const reference={source:'session' as const,ownerId:'s',artifactId:retained.id};expect(await inspectArtifact(input,reference,true,signal)).toMatchObject({integrity:'verified',text:content});
  const {rename,symlink}=await import('node:fs/promises');
  await rename(root,root+'-outside');await symlink(root+'-outside',root);
  expect((await inspectArtifact(input,reference,true,signal)).integrity).toBe('unavailable');
  await rm(root);await rename(root+'-outside',root);
  expect((await listArtifacts({...input,profileId:'other'},{},signal)).items).toEqual([]);await expect(inspectArtifact({...input,profileId:'other'},reference,true,signal)).rejects.toThrow();
  await db.appendMessage({id:'turn',sessionId:'s',role:'user',content:'Read the report'});
  await db.appendEvent('s',{kind:'execution-evidence-recorded',toolCallId:'read',tool:'file.read',status:'success',riskClass:'read-only-local',visibleTurnId:'turn',executionEffect:{kind:'read'}});
  await db.appendEvent('s',{kind:'execution-final-outcome-recorded',turnMessageId:'turn',status:'completed',completionFloor:'read',terminationCause:'normal'});
  expect((await workEvidence(input,work,signal)).state).toBe('verified');
  await db.appendMessage({id:'next',sessionId:'s',role:'user',content:'Another task'});expect((await workEvidence(input,work,signal)).state).toBe('unverified');
 }finally{db.close();await rm(homeDir,{recursive:true,force:true});}
});
