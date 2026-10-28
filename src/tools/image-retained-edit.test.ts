import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,chmod,symlink,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ArtifactStore} from '../artifacts/artifact-store.js';
import type {SessionArtifactRegistration} from '../contracts/artifact.js';
import {createImageGenerationTools,type ImageGenerationFetchLike} from './image-generation-tools.js';
const roots:string[]=[];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ9kAAAAASUVORK5CYII=','base64');
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup(provider:'byteplus'|'fal'|'openai',sourceBytes=png,mimeType='image/png'){
 const filename=mimeType==='image/gif'?'image.gif':'image.png';
 const root=await mkdtemp(join(tmpdir(),'estacoda-retained-edit-'));roots.push(root);const storageRoot=join(root,'artifacts');
 const store=new ArtifactStore({storageRoot}),capturePath=join(root,filename);await writeFile(capturePath,sourceBytes);
 let registration!:SessionArtifactRegistration;
 const retained=await store.retainSessionArtifact({sessionId:'session',profileId:'profile',capturePath,kind:'image',bytes:sourceBytes.length,mimeType,sha256:createHash('sha256').update(sourceBytes).digest('hex'),source:{kind:'image.generated',description:'Generated image',filename,origin:'media:image.generate'},persist:async value=>{registration=value;}});
 const requests:Array<{url:string;init:Parameters<ImageGenerationFetchLike>[1]}>=[];
 const fetch:ImageGenerationFetchLike=async(url,init)=>{requests.push({url,init});return {ok:true,status:200,statusText:'OK',headers:{get:()=> 'image/png'},text:async()=>JSON.stringify({data:[{b64_json:png.toString('base64')}]}),arrayBuffer:async()=>Uint8Array.from(png).buffer};};
 const env=provider==='byteplus'?'BYTEPLUS_ARK_API_KEY':provider==='fal'?'FAL_KEY':'OPENAI_API_KEY';vi.stubEnv(env,'test-only-key');
 const model=provider==='byteplus'?'seedream-5-0-260128':provider==='fal'?'fal-ai/flux-2/klein/9b':'gpt-image-2-medium';
 // A new store proves edits do not depend on in-memory artifact metadata or source URLs.
 const options={artifactStore:new ArtifactStore({storageRoot}),imageCacheRoot:join(root,'cache'),retainedImageRoot:storageRoot,profileId:'profile',currentSessionId:()=> 'session',readSessionArtifacts:async()=>[registration],imageGen:{provider,model,useGateway:false,apiKeyEnv:env},fetch};
 return {root,retained,registration,requests,options,tool:()=>createImageGenerationTools(options).find(tool=>tool.name==='image.edit')!};
}
describe('editing retained session images',()=>{
 for(const provider of ['byteplus','fal','openai'] as const)it(`uploads reverified same-session bytes through ${provider} after reopening`,async()=>{
  const s=await setup(provider);const result=await s.tool().run({prompt:'Cooler light',sourceImage:s.retained.path});expect(result.ok).toBe(true);expect(s.requests).toHaveLength(1);
  const body=s.requests[0]!.init!.body;
  if(provider==='openai'){expect(body).toBeInstanceOf(FormData);const part=(body as FormData).get('image[]') as File;expect(Buffer.from(await part.arrayBuffer())).toEqual(png);}
  else {const data=JSON.parse(body as string);expect(provider==='fal'?data.image_urls[0]:data.image).toBe('data:image/png;base64,'+png.toString('base64'));}
  expect(JSON.stringify(result)).not.toContain(png.toString('base64'));expect(result.metadata).toMatchObject({metadata:{sourceImages:[s.retained.path]}});
 });
 it('rejects another profile, another session, and arbitrary data or file paths without dispatch',async()=>{
  const s=await setup('byteplus');
  for(const registration of [{...s.registration,profileId:'other'},{...s.registration,sessionId:'other'}]){s.options.readSessionArtifacts=async()=>[registration];expect((await s.tool().run({prompt:'Edit',sourceImage:s.retained.path})).ok).toBe(false);}
  for(const source of [s.retained.localPath!,'data:image/png;base64,'+png.toString('base64')])expect((await s.tool().run({prompt:'Edit',sourceImage:source})).ok).toBe(false);
  expect(s.requests).toHaveLength(0);
 });
 it('rejects modified retained bytes and symlinks before a provider call',async()=>{
  const s=await setup('byteplus'),path=s.retained.localPath!;await chmod(path,0o600);const changed=Buffer.from(png);changed[changed.length-1]^=1;await writeFile(path,changed);
  expect((await s.tool().run({prompt:'Edit',sourceImage:s.retained.path})).ok).toBe(false);
  await unlink(path);const elsewhere=join(s.root,'elsewhere.png');await writeFile(elsewhere,png);await symlink(elsewhere,path);
  expect((await s.tool().run({prompt:'Edit',sourceImage:s.retained.path})).ok).toBe(false);expect(s.requests).toHaveLength(0);
 });
 it('preserves OpenAI source format restrictions for verified retained files',async()=>{
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  const s=await setup('openai',gif,'image/gif');
  const result=await s.tool().run({prompt:'Edit',sourceImage:s.retained.path});
  expect(result.ok).toBe(false);expect(result.metadata).toMatchObject({reason:'unsupported-source-mime'});expect(s.requests).toHaveLength(0);
 });
 it('keeps safe remote editing independent of retained-session reads',async()=>{
  const s=await setup('byteplus');s.options.readSessionArtifacts=async()=>{throw new Error('Unavailable');};
  const result=await s.tool().run({prompt:'Edit',sourceImage:'https://example.com/image.png'});
  expect(result.ok).toBe(true);expect(s.requests).toHaveLength(1);
 });
 it('bounds reference count before reading or uploading content',async()=>{
  const s=await setup('byteplus');const result=await s.tool().run({prompt:'Edit',sourceImages:Array(17).fill(s.retained.path)});expect(result.ok).toBe(false);expect(s.requests).toHaveLength(0);
 });
});
