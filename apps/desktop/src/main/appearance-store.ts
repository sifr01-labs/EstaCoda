import{mkdirSync,readFileSync,renameSync,statSync,writeFileSync}from'node:fs';
import{join}from'node:path';import{randomUUID}from'node:crypto';
import{DEFAULT_APPEARANCE,validAppearance,type AppearancePreferences}from'../shared/appearance.js';
/** Presentation only. This file never supplies runtime/profile authority. */
export class AppearanceSettings {
 constructor(readonly directory:string){}
 read():AppearancePreferences {try{const file=join(this.directory,'appearance.json');if(statSync(file).size>4096)return{...DEFAULT_APPEARANCE};const value:unknown=JSON.parse(readFileSync(file,'utf8'));return validAppearance(value)?{...DEFAULT_APPEARANCE,...value}:{...DEFAULT_APPEARANCE};}catch{return{...DEFAULT_APPEARANCE};}}
 write(value:unknown):void {if(!validAppearance(value))throw new Error('Invalid appearance preferences.');mkdirSync(this.directory,{recursive:true,mode:0o700});const temporary=join(this.directory,'appearance-'+randomUUID()+'.tmp');writeFileSync(temporary,JSON.stringify({...DEFAULT_APPEARANCE,...value})+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,join(this.directory,'appearance.json'));}
}
