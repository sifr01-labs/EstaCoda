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
 project(skill:LoadedSkill):LibrarySkill{return{id:libraryId(skill.name),name:safeText(skill.name,240),description:safeText(skill.description),source:skill.sourceKind==='local'?'local':skill.sourceKind==='external'?'external':'bundled',version:skill.version?safeText(skill.version,80):null,requiredToolsets:skill.requiredToolsets.slice(0,64),optionalToolsets:(skill.optionalToolsets??[]).slice(0,64)};}
 async skills(offset=0){const skills=(await this.registry()).listLoaded().sort((a,b)=>a.name.localeCompare(b.name));return{items:skills.slice(offset,offset+50).map(s=>this.project(s)),nextOffset:offset+50<skills.length?offset+50:null};}
 async skill(id:string):Promise<LibrarySkillDetail>{const skill=(await this.registry()).listLoaded().find(s=>libraryId(s.name)===id);if(!skill)throw new ControlProtocolError('-32004');return{skill:this.project(skill),instructions:safeText(skill.instructions,16384),truncated:skill.instructions.length>16384};}
 async memory(){const items:LibraryMemory[]=[];for(const kind of ['USER.md','SOUL.md','MEMORY.md'] as const){const raw=await readProfileFile(this.paths.profileRoot,join(this.paths.profileRoot,kind));if(raw!==undefined)items.push({kind,scope:'profile',content:safeText(raw,16384),truncated:raw.length>16384});}return{items};}
}
