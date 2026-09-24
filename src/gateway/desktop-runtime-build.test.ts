import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {realpathSync,mkdtempSync,mkdirSync,writeFileSync,renameSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectDesktopRuntimeBuild} from './desktop-runtime-build.js';

it('binds activation to retained runtime content and its own interpreter, including paths with spaces',()=>{
 const temp=mkdtempSync(join(tmpdir(),'runtime build '));
 try{
  const staging=join(temp,'runtime-versions','stage'),node=process.platform==='win32'?'node.exe':'node';
  mkdirSync(join(staging,'core/dist'),{recursive:true});
  const files=[{path:'core/dist/index.js',body:'entry'},{path:node,body:'node'}].map(f=>{writeFileSync(join(staging,f.path),f.body);return {path:f.path,bytes:Buffer.byteLength(f.body),sha256:createHash('sha256').update(f.body).digest('hex')};});
  const digest=createHash('sha256').update(JSON.stringify(files)).digest('hex');
  writeFileSync(join(staging,'manifest.json'),JSON.stringify({version:2,platform:process.platform,arch:process.arch,runtimeSha256:digest,nodeSha256:files[1]!.sha256,entrySha256:files[0]!.sha256,files}));
  const root=join(temp,'runtime-versions',digest);renameSync(staging,root);
  expect(inspectDesktopRuntimeBuild(join(root,'core'),join(root,node),true)).toEqual({workspaceRoot:realpathSync(join(root,'core')),digest});
  expect(inspectDesktopRuntimeBuild(join(root,'core'),process.execPath,true)).toBeUndefined();
  writeFileSync(join(root,'core/dist/index.js'),'tampered');
  expect(inspectDesktopRuntimeBuild(join(root,'core'),join(root,node),true)).toBeUndefined();
  writeFileSync(join(root,'core/dist/index.js'),'entry');
  symlinkSync(join(root,node),join(root,'linked'));
  expect(inspectDesktopRuntimeBuild(join(root,'core'),join(root,node),true)).toBeUndefined();
 }finally{rmSync(temp,{recursive:true,force:true});}
});
