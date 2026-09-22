import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,cpSync} from 'node:fs';
import {inventoryRuntime,runtimeDigest,verifyRuntimeInventory} from './runtime-integrity.js';
it('verifies a relocated closure and rejects changed, missing, extra or linked dependency assets',()=>{
 const root=mkdtempSync('/tmp/ec-runtime-');
 try {
  const source=root+'/source',moved=root+'/مرحبا moved';mkdirSync(source+'/core/node_modules/dependency',{recursive:true});
  writeFileSync(source+'/node','owned executable');writeFileSync(source+'/core/node_modules/dependency/entry.js','export const ok=true;');
  const files=inventoryRuntime(source),manifest={files,runtimeSha256:runtimeDigest(files)};writeFileSync(source+'/manifest.json',JSON.stringify(manifest));cpSync(source,moved,{recursive:true});
  expect(()=>verifyRuntimeInventory(moved,manifest)).not.toThrow();
  writeFileSync(moved+'/extra.js','injected');expect(()=>verifyRuntimeInventory(moved,manifest)).toThrow();rmSync(moved+'/extra.js');
  writeFileSync(moved+'/core/node_modules/dependency/entry.js','changed');expect(()=>verifyRuntimeInventory(moved,manifest)).toThrow();
  rmSync(moved+'/core/node_modules/dependency/entry.js');expect(()=>verifyRuntimeInventory(moved,manifest)).toThrow();
  symlinkSync(source+'/core/node_modules/dependency/entry.js',moved+'/core/node_modules/dependency/entry.js');expect(()=>verifyRuntimeInventory(moved,manifest)).toThrow('linked');
  expect(()=>verifyRuntimeInventory(source,{files:[{path:'../../secret'}],runtimeSha256:'forged'})).toThrow();
 } finally {rmSync(root,{recursive:true,force:true});}
});

it('rejects cross-platform and cross-architecture staging before modifying runtime assets',()=>{
 const script=fileURLToPath(new URL('../../scripts/stage-runtime.mjs',import.meta.url));
 for(const target of [['unsupported',process.arch],[process.platform,'unsupported']]){
  try{execFileSync(process.execPath,[script,...target],{stdio:'pipe',timeout:10000});throw new Error('Unexpected staging success');}
  catch(error){expect(String((error as {stderr?:unknown}).stderr)).toContain('Package on a native runner matching the requested OS and architecture.');}
 }
});
