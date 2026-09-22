import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {realpathSync} from 'node:fs';
import {classifyInstallation} from './ownership.js';
import {UpdateCoordinator} from './coordinator.js';
it('requires a verified writable owned app and rejects external, mounted and translocated copies',()=>{
 const home=realpathSync(mkdtempSync('/tmp/ec-install-'));try{
 const bundle=home+'/Applications/EstaCoda.app';mkdirSync(bundle,{recursive:true});
 const base={home,bundle,packaged:true,platform:'darwin',publisherVerified:true};
 expect(classifyInstallation(base).canReplace).toBe(true);
 for(const [changes,ownership] of [[{packaged:false},'development'],[{platform:'win32'},'unsupported'],[{publisherVerified:false},'unverified'],[{bundle:'/Volumes/Disk/EstaCoda.app'},'mounted'],[{bundle:'/private/tmp/AppTranslocation/id/EstaCoda.app'},'translocated'],[{bundle:home},'external']] as const)expect(classifyInstallation({...base,...changes})).toEqual({ownership,canReplace:false});
 symlinkSync(bundle,home+'/linked.app');expect(classifyInstallation({...base,bundle:home+'/linked.app'}).ownership).toBe('external');
 }finally{rmSync(home,{recursive:true,force:true});}
});
it('serializes processes, releases failed operations and refuses interrupted locks',async()=>{
 const root=mkdtempSync('/tmp/ec-update-lock-');try{
 const first=new UpdateCoordinator(root),second=new UpdateCoordinator(root);let release!:()=>void;
 const pending=first.run(()=>new Promise<void>(resolve=>{release=resolve;}));
 await expect(second.run(async()=>true)).rejects.toThrow('busy');release();await pending;
 await expect(first.run(async()=>{throw Error('failed');})).rejects.toThrow('failed');
 expect(await second.run(async()=>true)).toBe(true);
 writeFileSync(root+'/operation.lock','interrupted');await expect(first.run(async()=>true)).rejects.toThrow('busy');
 }finally{rmSync(root,{recursive:true,force:true});}
});
