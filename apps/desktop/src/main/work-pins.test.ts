import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {WorkPins} from './work-pins.js';
import type {DesktopConnection} from './connection.js';
it('persists references only, resolves off-page Work, and fences profile switches',async()=>{
 const directory=mkdtempSync('/tmp/ec-pins-');
 let switchDuringRead=false;
 const connection={state:{profileId:'p',generation:1,status:'ready'},getWork:async(id:string)=>{if(switchDuringRead)connection.state.profileId='q';return{id,profileId:'p',title:'Private title',canonicalId:'canonical',kind:'session',status:'completed',updatedAt:0,target:null};}} as unknown as Pick<DesktopConnection,'state'|'getWork'>;
 try{const pins=new WorkPins(directory,connection);expect(await pins.set('s',true)).toHaveLength(1);expect(readFileSync(join(directory,readdirSync(directory)[0]!),'utf8')).toBe('["s"]');expect(await new WorkPins(directory,connection).list()).toHaveLength(1);connection.state.profileId='q';expect(await pins.list()).toEqual([]);connection.state.profileId='p';switchDuringRead=true;await expect(pins.set('other',true)).rejects.toThrow('context');}finally{rmSync(directory,{recursive:true,force:true});}
});
