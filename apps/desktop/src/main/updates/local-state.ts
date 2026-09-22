import {mkdirSync,lstatSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
/** Only fixed Main-owned filenames and bounded nonsecret presentation/receipt data. */
export class UpdateLocalState {
 constructor(readonly directory:string){}
 read(name:'preferences.json'|'receipt.json'):unknown {
  try{const file=join(this.directory,name),stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)return {invalid:true};return JSON.parse(readFileSync(file,'utf8'));}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?null:{invalid:true};}
 }
 write(name:'preferences.json'|'receipt.json',value:unknown):void {
  const text=JSON.stringify(value);if(text.length>16384)throw Error('Update state exceeds limit');
  mkdirSync(this.directory,{recursive:true,mode:0o700});const stat=lstatSync(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid update state directory');
  const temporary=join(this.directory,randomUUID()+'.tmp');try{writeFileSync(temporary,text,{flag:'wx',mode:0o600});renameSync(temporary,join(this.directory,name));}finally{rmSync(temporary,{force:true});}
 }
}
