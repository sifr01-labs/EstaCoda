import {it,expect} from 'vitest';
import {BrowserControlOwner} from './control-lease.js';
it('fences concurrent controllers, replay and old generations before returning to agent',async()=>{
 const owner=new BrowserControlOwner(),lease=owner.acquire('window');
 expect(()=>owner.acquire('other')).toThrow();await expect(owner.agent(async()=>1)).rejects.toThrow('paused');
 await expect(owner.human('other',lease,1,async()=>1)).rejects.toThrow('stale');
 expect(await owner.human('window',lease,1,async()=>42)).toBe(42);
 await expect(owner.human('window',lease,1,async()=>1)).rejects.toThrow('replayed');
 owner.release('window',lease);expect(await owner.agent(async()=>42)).toBe(42);
 const next=owner.acquire('window');expect(next.generation).toBeGreaterThan(lease.generation);expect(()=>owner.release('window',lease)).toThrow('stale');
});
it('requires quiescence in both directions and does not resume on expiry or uncertain input',async()=>{
 let now=0,settle!:()=>void;const owner=new BrowserControlOwner(()=>now,100);
 const action=owner.agent(()=>new Promise<void>(resolve=>settle=resolve));expect(()=>owner.acquire('window')).toThrow('busy');settle();await action;
 const lease=owner.acquire('window'),input=owner.human('window',lease,1,()=>new Promise<void>(resolve=>settle=resolve));
 expect(()=>owner.release('window',lease)).toThrow('settling');now=101;expect(()=>owner.acquire('next')).toThrow('busy');settle();await expect(input).rejects.toThrow('stale');
 await expect(owner.agent(async()=>1)).rejects.toThrow('paused');const recovered=owner.acquire('next');owner.release('next',recovered);expect(await owner.agent(async()=>1)).toBe(1);
 const uncertain=owner.acquire('window');await expect(owner.human('window',uncertain,1,async()=>{throw new Error('lost');})).rejects.toThrow('lost');await expect(owner.agent(async()=>1)).rejects.toThrow('paused');
 owner.close();expect(()=>owner.acquire('next')).toThrow();
});
