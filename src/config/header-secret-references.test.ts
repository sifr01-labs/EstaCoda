import {it,expect} from 'vitest';import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {resolveHeaderReferences,profileHeaderEnvironment} from './header-secret-references.js';import {resolveProfileStateHome} from './profile-home.js';
it('resolves exact profile references and fails closed on missing or malformed headers',()=>{
 expect(resolveHeaderReferences({'X-Plain':'plain'},{Authorization:'PRIVATE_HEADER'},{PRIVATE_HEADER:'Bearer fixture'})).toEqual({headers:{'X-Plain':'plain',Authorization:'Bearer fixture'},configured:true});
 for(const value of [undefined,'injected\r\nHost: other'])expect(resolveHeaderReferences({}, {Authorization:'PRIVATE_HEADER'},{PRIVATE_HEADER:value}).configured).toBe(false);
 expect(resolveHeaderReferences({}, {'Bad\nName':'PRIVATE_HEADER'},{PRIVATE_HEADER:'value'}).configured).toBe(false);
});
it('never borrows another profile credential or follows an env-file symlink',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-header-'));try{const p=resolveProfileStateHome({homeDir,profileId:'one'}),q=resolveProfileStateHome({homeDir,profileId:'two'});await mkdir(p.profileRoot,{recursive:true});await mkdir(q.profileRoot,{recursive:true});await writeFile(p.envPath,'HEADER_SECRET=one\n');expect(await profileHeaderEnvironment({homeDir,profileId:'one'})).toEqual({HEADER_SECRET:'one'});expect(await profileHeaderEnvironment({homeDir,profileId:'two'})).toEqual({});await symlink(p.envPath,q.envPath);await expect(profileHeaderEnvironment({homeDir,profileId:'two'})).rejects.toThrow();}finally{await rm(homeDir,{recursive:true,force:true});}
});

it('replaces a legacy HTTP header case-insensitively instead of sending both credentials',()=>{expect(resolveHeaderReferences({Authorization:'legacy','X-Plain':'plain'},{authorization:'PRIVATE_HEADER'},{PRIVATE_HEADER:'Bearer replacement'})).toEqual({headers:{'X-Plain':'plain',authorization:'Bearer replacement'},configured:true});});
