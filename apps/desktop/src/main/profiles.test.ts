import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {Profiles} from './profiles.js';
import {resolveGlobalStateHome} from '../../../../src/config/profile-home.js';
it('defaults discovery to the CLI selection without changing it or accepting linked profiles',()=>{
 const home=mkdtempSync('/tmp/ec-profile-choice-'),paths=resolveGlobalStateHome({homeDir:home});
 try {
  mkdirSync(paths.profilesRoot,{recursive:true});for(const id of ['default','cli'])mkdirSync(paths.profilesRoot+'/'+id);
  symlinkSync(paths.profilesRoot+'/cli',paths.profilesRoot+'/linked');
  const pointer=JSON.stringify({profileId:'cli'});writeFileSync(paths.activeProfilePath,pointer);
  const profiles:Profiles=new Profiles(home);expect(profiles.initial()).toBe('cli');expect(profiles.list().map(row=>row.id)).toEqual(['cli','default']);
  profiles.assertSelectable('default');expect(()=>profiles.assertSelectable('linked')).toThrow();expect(()=>profiles.assertSelectable('../cli')).toThrow();
  expect(readFileSync(paths.activeProfilePath,'utf8')).toBe(pointer);
  writeFileSync(paths.activeProfilePath,'{');expect(profiles.initial()).toBe('default');expect(readFileSync(paths.activeProfilePath,'utf8')).toBe('{');
 } finally {rmSync(home,{recursive:true,force:true});}
});
