import {it,expect} from 'vitest';
import type {SessionRecord,SessionMessage} from '../contracts/session.js';
import {appendSessionEvents,sessionActivity,type DisplayEvent} from './work-projections.js';
const session={id:'s',profileId:'p'} as SessionRecord;
it('projects only safe display identity and phase, never provider-native data or tool payloads',()=>{
 const createdAt='2026-09-17T10:00:00Z';
 const messages=[{id:'progress',role:'agent',content:'Reading source',createdAt,metadata:{kind:'provider-tool-call-turn',providerReplayEcho:'secret-reasoning'}},{id:'final',role:'agent',content:'Done',createdAt,metadata:{finalOutcome:{}}}] as unknown as SessionMessage[];
 const calls:DisplayEvent[]=[{id:'one',createdAt,event:{kind:'tool-called',tool:'files.read',toolCallId:'private-call-reference',input:{secret:'input-canary'}}},{id:'two',createdAt,event:{kind:'tool-result',tool:'files.read',toolCallId:'private-call-reference',result:{ok:true,content:'output-canary'}}}];
 const items=appendSessionEvents(session,sessionActivity(session,messages),calls);
 expect(items.filter(x=>x.kind==='message').map(x=>x.phase)).toEqual(['progress','response']);
 const tools=items.filter(x=>x.kind==='tool');expect(tools[0]?.callId).toMatch(/^[a-f0-9]{64}$/);expect(tools[0]?.callId).toBe(tools[1]?.callId);
 expect(JSON.stringify(items)).not.toMatch(/canary|private-call-reference|secret-reasoning/);
});
it('projects retained output handles only for the selected session/profile and preserves recovered outcome evidence',()=>{
 const artifact={id:'artifact',sessionId:'s',profileId:'p',source:{filename:'/private/directory/report.yaml'},storageKey:'secret-storage-key',bytes:24,mimeType:'text/yaml'};
 const events=[{id:'a',event:{kind:'session-artifact-registered',artifact}},{id:'b',event:{kind:'session-artifact-registered',artifact:{...artifact,profileId:'other'}}},{id:'c',event:{kind:'session-artifact-registered',artifact:{...artifact,sessionId:'other'}}},{id:'r',event:{kind:'execution-final-outcome-recorded',status:'completed_with_recovered_errors'}}].map(x=>({...x,createdAt:'2026-09-17T10:00:00Z'})) as unknown as DisplayEvent[];
 const items=appendSessionEvents(session,[],events);expect(items).toHaveLength(2);expect(items[0]).toMatchObject({kind:'artifact',label:'report.yaml',reference:{source:'session',ownerId:'s',artifactId:'artifact'}});expect(items[1]).toMatchObject({kind:'result',status:'completed',recoveredErrors:true});expect(JSON.stringify(items)).not.toMatch(/private|storage/);
});

it('reads bounded display metadata through paginated SQLite history',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {SQLiteSessionDB}=await import('../session/sqlite-session-db.js');const {historyBoundary,historyPage}=await import('./session-history.js');
 const dir=await mkdtemp('/tmp/ec-conversation-');const db=new SQLiteSessionDB({path:dir+'/sessions.sqlite'});
 try{
  const saved=await db.createSession({id:'s',profileId:'p'});
  await db.appendMessage({sessionId:'s',role:'agent',content:'Checking',metadata:{kind:'provider-tool-call-turn',private:'message-canary'}});
  await db.appendEvent('s',{kind:'tool-called',tool:'files.read',toolCallId:'read',input:{secret:'input-canary'}});
  await db.appendEvent('s',{kind:'tool-result',tool:'files.read',toolCallId:'read',result:{ok:true,content:'output-canary'}});
  await db.appendEvent('s',{kind:'session-artifact-registered',artifact:{id:'file',sessionId:'s',profileId:'p',bytes:42,mimeType:'text/plain',storageKey:'storage-canary',source:{filename:'report.txt'}}} as never);
  const boundary=historyBoundary(db.db,saved);expect(boundary.count).toBe(4);
  const items=Array.from({length:4},(_,i)=>historyPage(db.db,saved,boundary,i,1)).flat();
  expect(items.find(i=>i.kind==='message')).toMatchObject({phase:'progress'});
  const tools=items.filter(i=>i.kind==='tool');expect(tools[0]?.callId).toBe(tools[1]?.callId);expect(tools[0]?.callId).toBeTruthy();
  expect(items.find(i=>i.kind==='artifact')).toMatchObject({label:'report.txt',reference:{source:'session',ownerId:'s',artifactId:'file'}});expect(JSON.stringify(items)).not.toContain('canary');
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
