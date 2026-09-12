import {EventEmitter} from 'node:events';import {it,expect,vi} from 'vitest';
import {DesktopPublicSettings} from './public-settings.js';
it('keeps staged candidate identity in Main and invalidates settings across profile changes',async()=>{
 const calls:any[]=[];const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1},settingsRequest:async(method:string,params:any)=>{calls.push({method,params});if(method==='settings.read')return{fields:[{id:'web.brave.apiKeyEnv',path:['web','brave','apiKeyEnv'],section:'browser',kind:'secret'}],values:[],truncated:false};if(method==='settings.review')return{draftId:'draft',changes:[{fieldId:'web.brave.apiKeyEnv',selectors:[],value:'staged'}],previous:[],expiresInMs:300000};if(method==='settings.cancel')return{cancelled:true};return{operationId:'draft',state:'applied'};}});
 const pipe={closeWindow:vi.fn(async()=>{})},credentials={close:vi.fn(),open:vi.fn((_p,_s,success)=>success('private-candidate'))};const owner=new DesktopPublicSettings(connection as any,credentials as any,()=>pipe as any);
 await owner.read('browser');const {setupId}=owner.begin();await expect(owner.review(setupId,[{fieldId:'web.brave.apiKeyEnv',selectors:[],value:'raw-secret'}])).rejects.toThrow();
 await owner.stage(setupId,'web.brave.apiKeyEnv',[]);const review=await owner.review(setupId,[{fieldId:'web.brave.apiKeyEnv',selectors:[],value:'staged'}]);expect(JSON.stringify(review)).not.toContain('private-candidate');expect(calls.find(c=>c.method==='settings.review').params.changes[0].value).toBe('private-candidate');await owner.cancel(setupId);expect(pipe.closeWindow).toHaveBeenCalled();
 const next=owner.begin();connection.state.generation++;connection.emit('invalidate');expect(()=>owner.require(next.setupId)).toThrow();
});
