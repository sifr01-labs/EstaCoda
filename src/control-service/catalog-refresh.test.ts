import {mkdtemp,rm} from 'node:fs/promises';
import {afterEach,it,expect,vi} from 'vitest';
import {resetModelsDevRegistryForTest} from '../model-catalog/models-dev-registry.js';
import {refreshDesktopCatalog} from './catalog-refresh.js';
afterEach(()=>{vi.unstubAllGlobals();resetModelsDevRegistryForTest();});
it('refreshes only fixed public metadata without credentials and rejects oversized responses',async()=>{
 const root=await mkdtemp('/tmp/ec-catalog-refresh-');
 try{
  const fetch=vi.fn(async(url,init)=>{expect(url).toBe('https://models.dev/api.json');expect(init.redirect).toBe('error');expect(init.headers).toEqual({accept:'application/json'});return new Response('{}');});vi.stubGlobal('fetch',fetch);
  expect(await refreshDesktopCatalog(root,new AbortController().signal)).toEqual({refreshed:true});expect(fetch).toHaveBeenCalledOnce();
  resetModelsDevRegistryForTest();vi.stubGlobal('fetch',async()=>new Response(new Uint8Array(16*1024*1024+1)));
  expect(await refreshDesktopCatalog(root,new AbortController().signal)).toEqual({refreshed:false});
 }finally{await rm(root,{recursive:true,force:true});}
});
