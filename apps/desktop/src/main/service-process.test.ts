import {mkdtemp, mkdir, readFile, writeFile, copyFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import { expect, it } from 'vitest';
import {inventoryRuntime,runtimeDigest} from './runtime-integrity.js';
import { validateProfileId, ownedRuntime, ServiceProcess } from './service-process.js';
it('rejects profile traversal, flags and noncanonical identities', () => {
  for (const id of ['../other', '--inspect', '', '..', 'a/b', 'a'.repeat(161), null]) expect(() => validateProfileId(id)).toThrow();
  expect(() => validateProfileId('personal-2')).not.toThrow();
});
it('fails closed without owned runtime metadata', () => {
  expect(() => ownedRuntime('/definitely-unavailable-runtime')).toThrow();
});

it('lets a connector shebang resolve verified Node without inheriting shell secrets', async () => {
  const root=await mkdtemp(join(tmpdir(),'ec-owned-node-'));
  const service=new ServiceProcess(root,root);
  try {
    await mkdir(join(root,'core/dist'),{recursive:true});
    const executable=join(root,process.platform==='win32'?'node.exe':'node');
    await copyFile(process.execPath,executable);
    const entry=join(root,'core/dist/index.js');
    await writeFile(entry,`const {spawnSync}=require('node:child_process');
const child=spawnSync('/usr/bin/env',['node','-p','process.execPath'],{env:process.env,encoding:'utf8'});
console.log(JSON.stringify({status:child.status,node:child.stdout.trim(),secretPresent:'ESTACODA_TEST_SECRET' in process.env}));`);
    const hash=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
    const files=inventoryRuntime(root);
    await writeFile(join(root,'manifest.json'),JSON.stringify({version:2,files,runtimeSha256:runtimeDigest(files),platform:process.platform,arch:process.arch,nodeSha256:await hash(process.execPath),entrySha256:await hash(entry)}));
    const manifestPath=join(root,'manifest.json'),metadata=JSON.parse(await readFile(manifestPath,'utf8'));
    await writeFile(manifestPath,JSON.stringify({...metadata,version:1}));expect(()=>ownedRuntime(root)).toThrow();
    await writeFile(manifestPath,JSON.stringify(metadata));
    const old=process.env.ESTACODA_TEST_SECRET;process.env.ESTACODA_TEST_SECRET='test-only';
    let transport;
    try { transport=service.start('default'); } finally { if(old===undefined)delete process.env.ESTACODA_TEST_SECRET;else process.env.ESTACODA_TEST_SECRET=old; }
    let output='';for await(const chunk of transport.output)output+=chunk.toString();
    expect(JSON.parse(output)).toEqual({status:0,node:await realpath(executable),secretPresent:false});
  } finally { service.stop();await rm(root,{recursive:true,force:true}); }
});
