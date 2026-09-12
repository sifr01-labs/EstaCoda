import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {it,expect,vi} from 'vitest';
import {WorkAttachments} from './work-attachments.js';
import {DesktopWorkControls} from './work-controls.js';
const target={targetId:'target',targetGeneration:1};
it('reads actual bounded UTF-8 contents and refuses symlinks, binary, stale scopes, and invalidated handles',async()=>{
 const directory=mkdtempSync('/tmp/ec-attachments-'),store=new WorkAttachments(),scope={profileId:'p',generation:1,target,draftId:'draft'};
 try{const path=join(directory,'notes.md');writeFileSync(path,'مرحبا billing');const [file]=await store.stage([path],scope,()=>{});expect(store.compose(scope,[file!.id],'Review')).toContain('مرحبا billing');expect(()=>store.compose({...scope,profileId:'q'},[file!.id],'Review')).toThrow('another target');symlinkSync(path,join(directory,'link.md'));await expect(store.stage([join(directory,'link.md')],scope,()=>{})).rejects.toThrow();writeFileSync(path,Buffer.from([0xff,0]));await expect(store.stage([path],scope,()=>{})).rejects.toThrow('UTF-8');writeFileSync(path,'a'.repeat(8193));await expect(store.stage([path],scope,()=>{})).rejects.toThrow('8 KB');store.clear();expect(()=>store.compose(scope,[file!.id],'Review')).toThrow('expired');}finally{rmSync(directory,{recursive:true,force:true});}
});
it('submits actual attachment contents once and retains a recovery pointer across Main restart',async()=>{
 const directory=mkdtempSync('/tmp/ec-work-main-');const path=join(directory,'notes.txt');writeFileSync(path,'actual attached evidence');
 const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1,status:'ready'},getWork:vi.fn(async(id:string)=>({id,profileId:'p',canonicalId:id.slice(8),kind:'session',target,actions:[{id:'sessions.send',enabled:true}]})),workRequest:vi.fn(async(method:string,params:any)=>method==='work.targets'?{items:[target],truncated:false}:{...params,profileId:'p',method:method==='operations.inspect'?params.method:method,state:'completed',cancellation:'not_requested'})});
 try{const main=new DesktopWorkControls(connection as any,directory,async()=>[path]);const [file]=await main.attach({draftId:'draft',target});const input={draftId:'draft',target,text:'Review',attachmentIds:[file!.id]};const result=await main.submit(input);const sent=connection.workRequest.mock.calls.find(call=>call[0]==='sessions.send')!;expect(sent[1].text).toContain('actual attached evidence');const restarted=new DesktopWorkControls(connection as any,directory,async()=>[]);expect(await restarted.submit(input)).toMatchObject({workId:result.workId});expect(connection.workRequest.mock.calls.filter(call=>call[0]==='sessions.send')).toHaveLength(1);expect(await restarted.inspect(result.workId)).toMatchObject({state:'completed',method:'sessions.send'});}finally{rmSync(directory,{recursive:true,force:true});}
});
