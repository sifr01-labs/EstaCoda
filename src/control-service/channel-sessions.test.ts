import {it,expect} from 'vitest';import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ChannelSessions} from './channel-sessions.js';import {SQLiteSessionDB} from '../session/sqlite-session-db.js';import {resolveGlobalStateHome} from '../config/profile-home.js';
it('projects only canonical profile sessions and revokes access without deleting Work',async()=>{const homeDir=await mkdtemp(join(tmpdir(),'ec-channel-sessions-'));await mkdir(join(homeDir,".estacoda"));const db=new SQLiteSessionDB({path:resolveGlobalStateHome({homeDir}).sessionsSqlitePath});try{
 await db.createSession({id:'own',profileId:'one'});await db.createSession({id:'foreign',profileId:'two'});const service=new ChannelSessions({homeDir,profileId:'one'});
 await service.pointers.setPointer('telegram','chat',{sessionId:'own',attachedAt:new Date().toISOString()});await service.pointers.setPointer('telegram','bad',{sessionId:'foreign',attachedAt:new Date().toISOString()});
 expect((await service.list()).items.map(row=>row.workId)).toEqual(['session:own']);await expect(service.details('foreign')).rejects.toThrow();
 const code=await service.handoffs.create({sessionId:'own',surfaceType:'telegram',ttlMinutes:10});expect((await service.details('own')).codes[0]?.code).toBe(code.code);
 await service.execute({operationId:'revoke',sessionId:'own',action:'revoke'});expect((await service.details('own')).codes).toEqual([]);
 await service.execute({operationId:'detach',sessionId:'own',action:'detach',attachmentId:'chat'});expect(await db.getSession('own')).toBeDefined();expect(await service.pointers.getPointer('telegram','chat')).toBeUndefined();
 await expect(service.execute({operationId:'create',sessionId:'own',action:'create'})).rejects.toThrow();
 }finally{db.close();await rm(homeDir,{recursive:true,force:true});}});
