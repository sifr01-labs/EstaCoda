import {it,expect,vi} from 'vitest';
import {createMockBrowserBackend} from './browser-backend.js';
import {gateBrowserBackend} from './control-gate.js';
import {BrowserControlOwner} from './control-lease.js';
it('fences semantic, raw and protected operations through the runtime backend',async()=>{
 const raw={...createMockBrowserBackend(),isSensitiveInputActive:()=>false,takeProtectedFieldDeliveryResult:()=>undefined,deliverProtectedField:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
 const owner=new BrowserControlOwner(),backend=gateBrowserBackend(raw,owner);
 expect(backend.isSensitiveInputActive!('b')).toBe(false);expect(backend.takeProtectedFieldDeliveryResult!({} as never)).toBeUndefined();
 await backend.navigate({url:'https://example.com'});const lease=owner.acquire('desktop');
 for(const method of ['navigate','snapshot','click','type','press','screenshot','cdp','deliverProtectedField'] as const){
  const operation=(backend as unknown as Record<string,(input:object)=>Promise<unknown>>)[method]!;
  await expect(operation({url:'https://example.com',method:'Runtime.evaluate'})).rejects.toThrow('paused');
 }
 expect(raw.deliverProtectedField).not.toHaveBeenCalled();expect(backend.isAvailable()).toBe(true);
 owner.release('desktop',lease);await expect(backend.navigate({url:'https://example.com'})).resolves.toHaveProperty('snapshot');
 await backend.close!();await expect(backend.snapshot!()).rejects.toThrow('paused');
});
