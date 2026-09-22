import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {desktopDistribution} from './settings-lifecycle.js';
it('keeps retained desktop runtime generations owned by Desktop',()=>{
 const root=mkdtempSync('/tmp/ec-owner-');try{
 mkdirSync(root+'/dist/control-service',{recursive:true});const module=pathToFileURL(root+'/dist/control-service/settings-lifecycle.js').href;
 expect(desktopDistribution(module)).toBe(false);writeFileSync(root+'/package.json',JSON.stringify({name:'estacoda',estacodaDistribution:'desktop-bundle'}));expect(desktopDistribution(module)).toBe(true);
 writeFileSync(root+'/package.json',JSON.stringify({name:'other',estacodaDistribution:'desktop-bundle'}));expect(desktopDistribution(module)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
