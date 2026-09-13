import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {HostEnvironment} from '../execution/host-environment.js';
import {evolutionGates} from './evolution-gates.js';
it('settles owned gate processes on failure, output overflow and cancellation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'evolution-process-'));const env=await HostEnvironment.create({profileId:'p',workspaceRoot:root,policy:{backend:'host'}});
 try{for(const mode of ['failure','overflow','abort'] as const){const lease=env.acquire({profileId:'p',sessionId:mode,surface:'test'}),controller=new AbortController();const spawn=lease.processes.spawn.bind(lease.processes),calls:string[]=[];
 lease.processes.spawn=(command,args)=>{calls.push([command,...args].join(' '));const child=spawn(process.execPath,['-e',mode==='failure'?'process.exit(3)':mode==='overflow'?"process.stdout.write('x'.repeat(1100000));setInterval(()=>{},1000)":'setInterval(()=>{},1000)']);if(mode==='abort')setTimeout(()=>controller.abort(),20);return child;};
 const run=evolutionGates(lease,['pnpm run test'],controller.signal);if(mode==='abort')await expect(run).rejects.toThrow();else expect(await run).toBe(false);expect(calls).toEqual(['pnpm run test']);await lease.release();}
 }finally{await env.destroy();await rm(root,{recursive:true,force:true});}
});
