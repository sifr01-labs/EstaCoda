import {cpSync,mkdirSync,lstatSync,readFileSync,renameSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ownedRuntime} from '../service-process.js';
/** Immutable copies outlive the .app. No automatic GC: a supervisor may load a
 * dependency long after its launching bridge/window exits. Never infer safety from PID alone. */
export function retainRuntime(source:string,cache:string):string {
 ownedRuntime(source);
 const manifest=JSON.parse(readFileSync(join(source,'manifest.json'),'utf8'));
 if(!/^[a-f0-9]{64}$/.test(manifest.runtimeSha256))throw Error('Invalid runtime identity');
 mkdirSync(cache,{recursive:true,mode:0o700});
 const stat=lstatSync(cache);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid runtime cache');
 const target=join(cache,manifest.runtimeSha256);
 if(existsSync(target)){ownedRuntime(target);return target;}
 const staging=join(cache,'.stage-'+randomUUID());
 try{
  cpSync(source,staging,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});
  ownedRuntime(staging);
  // Concurrent launches may publish the same immutable content; validate the winner.
  try{renameSync(staging,target);}catch(error){if(!existsSync(target))throw error;ownedRuntime(target);}
  return target;
 }finally{rmSync(staging,{recursive:true,force:true});}
}
