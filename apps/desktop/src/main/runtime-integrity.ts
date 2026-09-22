import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

export type RuntimeFile = {path:string;bytes:number;sha256:string};
/** Relocatable content identity. Publisher authentication remains the installer's job. */
export function inventoryRuntime(root:string):RuntimeFile[] {
 const files:RuntimeFile[]=[];let total=0,entries=0;
 const walk=(path:string,relative:string,depth:number)=>{
  if(depth>32||++entries>100000)throw new Error('Runtime inventory exceeds limits.');
  const stat=lstatSync(path);
  if(stat.isSymbolicLink())throw new Error('Runtime contains a linked asset.');
  if(stat.isDirectory()){
   for(const name of readdirSync(path).sort()){
    if(!relative&&name==='manifest.json')continue;
    walk(join(path,name),relative?relative+'/'+name:name,depth+1);
   }
  }else{
   if(!stat.isFile()||stat.size>512*1024*1024||(total+=stat.size)>2*1024*1024*1024)throw new Error('Invalid runtime asset.');
   files.push({path:relative,bytes:stat.size,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
  }
 };
 walk(root,'',0);return files;
}
export function runtimeDigest(files:RuntimeFile[]):string {
 return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
export function verifyRuntimeInventory(root:string,manifest:{files?:unknown;runtimeSha256?:unknown}):void {
 if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>100000)throw new Error('Missing runtime inventory.');
 const actual=inventoryRuntime(root);
 // Compare to a fresh inventory rather than following paths supplied by metadata.
 if(JSON.stringify(actual)!==JSON.stringify(manifest.files)||runtimeDigest(actual)!==manifest.runtimeSha256)throw new Error('Desktop runtime requires repair.');
}
