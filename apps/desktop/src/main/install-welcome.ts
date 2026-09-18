import {lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Presentation acknowledgement only: never used to authorize setup or execution. */
export class InstallWelcome {
 constructor(readonly directory:string) {}
 read():{acknowledged:boolean} {
  try {
   const file=join(this.directory,'install-welcome.json'),info=lstatSync(file);
   if(!info.isFile()||info.isSymbolicLink()||info.size>1024)return {acknowledged:false};
   const value=JSON.parse(readFileSync(file,'utf8'));
   return {acknowledged:value.version===1&&value.acknowledged===true};
  } catch {return {acknowledged:false};}
 }
 acknowledge():void {
  mkdirSync(this.directory,{recursive:true,mode:0o700});
  const temporary=join(this.directory,'welcome-'+randomUUID()+'.tmp');
  writeFileSync(temporary,JSON.stringify({version:1,acknowledged:true})+'\n',{flag:'wx',mode:0o600});
  renameSync(temporary,join(this.directory,'install-welcome.json'));
 }
}
