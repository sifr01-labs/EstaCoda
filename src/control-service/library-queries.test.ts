import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {LibraryQueries} from './library-queries.js';import {resolveProfileStateHome} from '../config/profile-home.js';
it('reads only selected-profile memory and rejects linked state',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'library-'));const input={homeDir,profileId:'one'},root=resolveProfileStateHome(input).profileRoot,other=resolveProfileStateHome({homeDir,profileId:'two'}).profileRoot;
 try{await mkdir(root,{recursive:true});await mkdir(other,{recursive:true});await writeFile(join(root,'MEMORY.md'),'selected');await writeFile(join(other,'USER.md'),'other profile');const q=new LibraryQueries(input,join(homeDir,'absent'));expect(await q.memory()).toEqual({items:[{kind:'MEMORY.md',scope:'profile',content:'selected',truncated:false}]});expect(await q.skills()).toEqual({items:[],nextOffset:null});await symlink(join(other,'USER.md'),join(root,'USER.md'));await expect(q.memory()).rejects.toThrow();}finally{await rm(homeDir,{recursive:true,force:true});}
});

it('uses core source precedence and bounded instructions without leaking source paths',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'library-skills-')),input={homeDir,profileId:'one'},paths=resolveProfileStateHome(input),bundled=join(homeDir,'bundled');
 const write=async(root:string,description:string)=>{await mkdir(join(root,'example'),{recursive:true});await writeFile(join(root,'example','SKILL.md'),'---\n'+JSON.stringify({name:'Example',description,requiredToolsets:['files'],routing:{labels:[],triggerPatterns:[]},playbook:[],evaluations:[]})+'\n---\n'+'Instructions '.repeat(2000));};
 try{await write(bundled,'Bundled');await write(paths.skillsPath,'Local');const q=new LibraryQueries(input,bundled),page=await q.skills();expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({source:'local',description:'Local'});const detail=await q.skill(page.items[0]!.id);expect(detail.truncated).toBe(true);expect(detail.instructions.length).toBe(16384);expect(JSON.stringify(detail)).not.toContain(homeDir);}finally{await rm(homeDir,{recursive:true,force:true});}
});
