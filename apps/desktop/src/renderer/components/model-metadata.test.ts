import {expect,it} from 'vitest';
import {catalogPages,modelPrice} from './model-metadata.js';
it('keeps zero, small real prices and missing prices distinct',()=>{
 expect(modelPrice(0)).toBe('$0');expect(modelPrice(.025)).toBe('$0.025');expect(modelPrice(15)).toBe('$15');
 for(const missing of [undefined,null,NaN,Infinity,-1])expect(modelPrice(missing)).toBeNull();
});
it('loads the complete opaque catalog before it can be compared',async()=>{
 const calls:(string|undefined)[]=[];
 const items=await catalogPages(async cursor=>{calls.push(cursor);return cursor?{items:['new-model'],nextCursor:null}:{items:['primary'],nextCursor:'next'};});
 expect(items).toEqual(['primary','new-model']);expect(calls).toEqual([undefined,'next']);
});
it('rejects repeated continuations and superseded loads instead of exposing partial catalogs',async()=>{
 await expect(catalogPages(async()=>({items:['partial'],nextCursor:'same'}))).rejects.toThrow('Catalog cursor repeated');
 await expect(catalogPages(async()=>({items:[],nextCursor:null}),()=>false)).rejects.toThrow('superseded');
});
