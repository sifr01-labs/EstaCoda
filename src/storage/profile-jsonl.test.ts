import {appendFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ProfileJsonl} from './profile-jsonl.js';
it('filters before materialization, retains bounded tails and detects old history changes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'profile-jsonl-')),path=join(root,'history.jsonl'),io=new ProfileJsonl(root);
 try{const rows=Array.from({length:1500},(_,i)=>({id:'row_'+i,value:i}));await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n'));
 expect(await io.query<{id:string;value:number}>(path,{where:r=>r.value>1400,offset:90,limit:3})).toEqual(rows.slice(1491,1494));
 expect(await io.query(path,{limit:3,tail:true})).toEqual(rows.slice(-3));const hash=await io.digest(path,()=>true);
 await io.rewrite<{id:string;value:number}>(path,'row_1',r=>({...r,value:99}));expect(await io.digest(path,()=>true)).not.toBe(hash);expect((await readFile(path,'utf8')).trim().split('\n')).toHaveLength(1500);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('fails closed on symlinks, invalid UTF-8, oversized rows and malformed rewrites without modifying the source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'profile-jsonl-')),path=join(root,'history.jsonl'),io=new ProfileJsonl(root);
 try{
  for(const content of [Buffer.from([255]),Buffer.from(JSON.stringify({id:'huge',value:'x'.repeat(1048576)})),Buffer.from('{invalid')]){await writeFile(path,content);await expect(io.query(path)).rejects.toThrow();await expect(io.rewrite(path,'x',r=>r)).rejects.toThrow();expect(await readFile(path)).toEqual(content);expect(await readdir(root)).toEqual(['history.jsonl']);}
  await symlink(path,join(root,'linked'));await expect(io.query(join(root,'linked'))).rejects.toThrow();await expect(io.query(join(root,'..','other'))).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});

it('preserves a concurrent append instead of replacing it with an old scan',async()=>{
 const root=await mkdtemp(join(tmpdir(),'profile-jsonl-')),path=join(root,'history.jsonl'),io=new ProfileJsonl(root);
 try{await writeFile(path,JSON.stringify({id:'first'})+'\n');await expect(io.rewrite(path,'first',row=>{appendFileSync(path,JSON.stringify({id:'later'})+'\n');return {...row,edited:true};})).rejects.toThrow('changed during rewrite');expect(await io.query(path)).toEqual([{id:'first'},{id:'later'}]);}
 finally{await rm(root,{recursive:true,force:true});}
});
