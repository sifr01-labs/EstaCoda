import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {InstallWelcome} from './install-welcome.js';
it('persists only presentation acknowledgement and fails closed on malformed or future state',()=>{
 const directory=mkdtempSync('/tmp/ec-welcome-');
 try {
  const store=new InstallWelcome(directory);expect(store.read()).toEqual({acknowledged:false});store.acknowledge();
  expect(new InstallWelcome(directory).read()).toEqual({acknowledged:true});
  expect(JSON.parse(readFileSync(directory+'/install-welcome.json','utf8'))).toEqual({version:1,acknowledged:true});
  for(const value of ['{','{"version":2,"acknowledged":true}','{"version":1,"acknowledged":"true"}']){writeFileSync(directory+'/install-welcome.json',value);expect(store.read().acknowledged).toBe(false);}
 } finally {rmSync(directory,{recursive:true,force:true});}
});
