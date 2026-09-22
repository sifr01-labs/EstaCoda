import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inventoryRuntime,runtimeDigest} from '../runtime-integrity.js';
import {retainRuntime} from './runtime-retention.js';
import {restartBlock,type RestartEvidence} from './restart-gate.js';
it('keeps immutable runtime dependencies after the app bundle is replaced',()=>{
 const root=mkdtempSync('/tmp/ec-retain-'),source=root+'/app/.runtime';
 const build=(version:string)=>{mkdirSync(source+'/core/dist',{recursive:true});writeFileSync(source+'/node','test node');writeFileSync(source+'/core/dist/index.js',version);writeFileSync(source+'/core/dist/late.cjs',"module.exports='"+version+"'");const files=inventoryRuntime(source),sha=(name:string)=>createHash('sha256').update(readFileSync(source+'/'+name)).digest('hex');writeFileSync(source+'/manifest.json',JSON.stringify({version:2,platform:process.platform,arch:process.arch,nodeSha256:sha('node'),entrySha256:sha('core/dist/index.js'),runtimeSha256:runtimeDigest(files),files}));};
 try{build('v1');const first=retainRuntime(source,root+'/cache');expect(retainRuntime(source,root+'/cache')).toBe(first);rmSync(root+'/app',{recursive:true});expect(readFileSync(first+'/core/dist/index.js','utf8')).toBe('v1');expect(spawnSync(process.execPath,['-e',"process.stdout.write(require(process.argv[1]))",first+'/core/dist/late.cjs'],{encoding:'utf8'}).stdout).toBe('v1');build('v2');const second=retainRuntime(source,root+'/cache');expect(first).not.toBe(second);expect(existsSync(first)).toBe(true);writeFileSync(second+'/core/dist/index.js','corrupt');expect(()=>retainRuntime(source,root+'/cache')).toThrow();}finally{rmSync(root,{recursive:true,force:true});}
});
it('requires fresh complete restart evidence and never authorizes active or uncertain resources',()=>{
 const ready:RestartEvidence={compatible:true,readersCoordinated:true,runtimeAssetsRetained:true,running:0,queued:0,terminals:0,browserTakeovers:0,credentialEntries:0,draftsSaved:true};expect(restartBlock(ready)).toBeUndefined();
 for(const change of [{compatible:false},{readersCoordinated:false},{runtimeAssetsRetained:false},{running:null},{running:1},{queued:1},{terminals:1},{browserTakeovers:1},{credentialEntries:1},{draftsSaved:false}])expect(restartBlock({...ready,...change})).toBeDefined();
});

it('fails closed on malformed restart counters from a lifecycle adapter',()=>{
 const ready:RestartEvidence={compatible:true,readersCoordinated:true,runtimeAssetsRetained:true,running:0,queued:0,terminals:0,browserTakeovers:0,credentialEntries:0,draftsSaved:true};
 for(const key of ['running','queued','terminals','browserTakeovers','credentialEntries'])for(const value of [undefined,null,NaN,-1,'0'])expect(restartBlock({...ready,[key]:value} as RestartEvidence)).toBeDefined();
});
