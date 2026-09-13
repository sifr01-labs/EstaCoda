import {createHash} from 'node:crypto';
import {lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {SkillRegistry} from '../skills/skill-registry.js';
import {parseSkillFile} from '../skills/skill-loader.js';
import type {LoadedSkill} from '../contracts/skill.js';
import {ControlProtocolError,type LibrarySkill,type LibrarySkillDetail,type LibraryMemory} from '../contracts/desktop-control/index.js';
import {readProfileFile} from './profile-attention.js';
import {safeText} from './work-projections.js';
export function boundedLibraryText(raw:string,max=16384){let value=safeText(raw,max);while(Buffer.byteLength(JSON.stringify(value))>40000)value=value.slice(0,Math.floor(value.length*.9));return value;}
export function boundedLibraryPage<T>(rows:T[],offset=0,maxItems=50,budget=80000){const items:T[]=[];let bytes=2;for(const row of rows.slice(offset,offset+maxItems)){const size=Buffer.byteLength(JSON.stringify(row))+1;if(bytes+size>budget)break;items.push(row);bytes+=size;}if(offset<rows.length&&!items.length)throw new ControlProtocolError('-32009');return{items,nextOffset:offset+items.length<rows.length?offset+items.length:null};}
export const libraryId=(name:string)=>createHash('sha256').update(name).digest('hex');
/** Profile state is data. Reading Library never hydrates scripts or starts a runtime. */
export class LibraryQueries{
 readonly paths;constructor(readonly input:{homeDir:string;profileId:string},readonly bundledRoot=fileURLToPath(new URL('../../skills/official',import.meta.url))){this.paths=resolveProfileStateHome(input);}
 async registry(){
  const registry=new SkillRegistry();let count=0;
  const scan=async(root:string,path:string,source:'local'|'bundled'|'external',depth=0):Promise<void>=>{
   let info;try{info=await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
   if(info.isSymbolicLink()||!info.isDirectory()||depth>6||++count>1000)throw new ControlProtocolError('-32003');
   const file=join(path,'SKILL.md'),raw=await readProfileFile(root,file);
   if(raw!==undefined){registry.register(parseSkillFile(file,raw,{sourceKind:source,sourceRoot:source==='local'?this.paths.skillsPath:source==='external'?join(this.paths.skillsPath,'packs'):this.bundledRoot}));return;}
   const entries=await readdir(path,{withFileTypes:true});if(entries.length>1000)throw new ControlProtocolError('-32009');
   for(const entry of entries){if(entry.name.startsWith('.')||source==='local'&&entry.name==='packs')continue;if(entry.isSymbolicLink())throw new ControlProtocolError('-32003');if(entry.isDirectory())await scan(root,join(path,entry.name),source,depth+1);}
  };
  await scan(this.paths.profileRoot,join(this.paths.skillsPath,'packs'),'external');await scan(this.bundledRoot,this.bundledRoot,'bundled');await scan(this.paths.profileRoot,this.paths.skillsPath,'local');return registry;
 }
 project(skill:LoadedSkill):LibrarySkill{return{id:libraryId(skill.name),name:safeText(skill.name,240),description:safeText(skill.description),source:skill.sourceKind==='local'?'local':skill.sourceKind==='external'?'external':'bundled',version:skill.version?safeText(skill.version,80):null,requiredToolsets:skill.requiredToolsets.slice(0,64).map(s=>safeText(s,80)),optionalToolsets:(skill.optionalToolsets??[]).slice(0,64).map(s=>safeText(s,80))};}
 async skills(offset=0){const skills=(await this.registry()).listLoaded().sort((a,b)=>a.name.localeCompare(b.name));return boundedLibraryPage(skills.map(s=>this.project(s)),offset,40);}
 async skill(id:string):Promise<LibrarySkillDetail>{const skill=(await this.registry()).listLoaded().find(s=>libraryId(s.name)===id);if(!skill)throw new ControlProtocolError('-32004');return{skill:this.project(skill),instructions:safeText(skill.instructions,16384),truncated:skill.instructions.length>16384};}
 async memory(){const items:LibraryMemory[]=[];for(const kind of ['USER.md','SOUL.md','MEMORY.md'] as const){const raw=await readProfileFile(this.paths.profileRoot,join(this.paths.profileRoot,kind));if(raw!==undefined){const content=boundedLibraryText(raw);items.push({kind,scope:'profile',content,truncated:raw.length>content.length});}}return{items};}
}
