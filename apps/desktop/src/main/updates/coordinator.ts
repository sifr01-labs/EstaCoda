import {mkdirSync,lstatSync,openSync,writeFileSync,closeSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
/** A process-wide instance plus exclusive file creation serialize every window/process.
 * Interrupted locks fail closed; no PID-only stale-lock takeover can replace live assets. */
export class UpdateCoordinator {
 private busy=false;
 constructor(readonly directory:string){}
 async run<T>(operation:()=>Promise<T>):Promise<T>{
  if(this.busy)throw new Error('Update operation busy');
  mkdirSync(this.directory,{recursive:true,mode:0o700});
  const stat=lstatSync(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Invalid update directory');
  const lock=join(this.directory,'operation.lock'),token=randomUUID();let descriptor:number;
  try{descriptor=openSync(lock,'wx',0o600);}catch{throw new Error('Update operation busy');}
  this.busy=true;
  try{writeFileSync(descriptor,token);return await operation();}
  finally{closeSync(descriptor);this.busy=false;if(lstatSync(lock).isFile()&&readFileSync(lock,'utf8')===token)unlinkSync(lock);}
 }
}
