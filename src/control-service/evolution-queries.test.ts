import {it,expect} from 'vitest';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {EvolutionQueries} from './evolution-queries.js';
it('projects proposal evidence without paths and distinguishes absent metadata evals from real tests',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'evolution-query-'));try{const q=new EvolutionQueries({homeDir,profileId:'one'},join(homeDir,'absent')),other=new EvolutionQueries({homeDir,profileId:'two'},join(homeDir,'absent'));const {store}=await q.open();const p=await store.proposePatch({skillName:'Example',reason:'Reviewed improvement',sourceTrust:'user_direct',patch:{type:'text_patch',oldString:'before',newString:'after'}});expect((await q.list()).items).toHaveLength(1);const d=await q.details(p.id);expect(d.gate.status).toBe('not-run');expect(d.evidence).toEqual([]);expect(JSON.stringify(d)).not.toContain(homeDir);expect((await other.list()).items).toEqual([]);await expect(other.details(p.id)).rejects.toThrow();}finally{await rm(homeDir,{recursive:true,force:true});}
});
it('rejects linked Evolution stores and usage metadata',async()=>{
 const {mkdir,writeFile,symlink}=await import('node:fs/promises');const homeDir=await mkdtemp(join(tmpdir(),'evolution-private-'));try{
 const q=new EvolutionQueries({homeDir,profileId:'one'},join(homeDir,'absent'));await mkdir(join(q.paths.skillsPath,'.evolution'),{recursive:true});const external=join(homeDir,'private');await writeFile(external,'{}');await symlink(external,join(q.paths.skillsPath,'.usage.json'));await expect(q.list()).rejects.toThrow();await rm(join(q.paths.skillsPath,'.usage.json'));await symlink(external,join(q.paths.skillsPath,'.evolution','observations.jsonl'));await expect(q.list()).rejects.toThrow();
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
it('resolves source Work only inside the selected profile',async()=>{
 const {SQLiteSessionDB}=await import('../session/sqlite-session-db.js');const {resolveGlobalStateHome}=await import('../config/profile-home.js');const homeDir=await mkdtemp(join(tmpdir(),'library-source-'));const input={homeDir,profileId:'one'},path=resolveGlobalStateHome(input).sessionsSqlitePath;const {mkdir}=await import('node:fs/promises');const {dirname}=await import('node:path');await mkdir(dirname(path),{recursive:true});const db=new SQLiteSessionDB({path});
 try{await db.createSession({id:'own',profileId:'one'});await db.createSession({id:'foreign',profileId:'two'});const q=new EvolutionQueries(input,join(homeDir,'absent'));expect(await q.sourceWork('own')).toBe('session:own');expect(await q.sourceWork('foreign')).toBeNull();expect(await q.sourceWork('missing')).toBeNull();}finally{db.close();await rm(homeDir,{recursive:true,force:true});}
});
