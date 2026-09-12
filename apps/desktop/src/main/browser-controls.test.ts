import {it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {DesktopBrowserControls} from './browser-controls.js';
import type {DesktopConnection} from './connection.js';
const reference={sessionId:'s',browserId:'b',eventId:1,target:{targetId:'t',targetGeneration:1}};
function fixture(){
 const frame={frameId:'f',url:'https://example.com',title:'Page',image:'jpeg',observedAt:'now'},request=vi.fn(async({command}:any)=>({lease:{id:'private-lease',generation:1},state:'human',frame:command.action==='observe'||command.action==='input'?frame:null}));
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready',generation:1,profileId:'p'},browserRequest:request,inspectionRequest:async()=>({items:[{reference,state:'recorded',url:frame.url}],truncated:false})}) as unknown as DesktopConnection;
 return{connection,request};
}
it('requires native consent, owns sequencing and abandons without returning control implicitly',async()=>{
 const{connection,request}=fixture();const controls=new DesktopBrowserControls(connection,async()=>true);
 try{const opened=await controls.open('session:s',reference);expect(Object.keys(opened)).toEqual(['id']);await controls.frame(opened.id);await controls.frame(opened.id,{kind:'key',frameId:'f',key:'ب'});
  expect(request.mock.calls.map(([value])=>value.command.action)).toEqual(['acquire','observe','input']);expect(request.mock.calls[2]![0].command.sequence).toBe(2);
  controls.abandon(opened.id);await expect(controls.frame(opened.id)).rejects.toThrow();expect(request.mock.calls.some(([value])=>value.command.action==='release')).toBe(false);
 }finally{controls.dispose();}
});
it('rejects cancelled consent and late observations after profile invalidation',async()=>{
 const{connection,request}=fixture(),cancelled=new DesktopBrowserControls(connection,async()=>false);await expect(cancelled.open('session:s',reference)).rejects.toThrow();expect(request).not.toHaveBeenCalled();cancelled.dispose();
 const controls=new DesktopBrowserControls(connection,async()=>true);try{const opened=await controls.open('session:s',reference);let finish!:(value:any)=>void;request.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const pending=controls.frame(opened.id);connection.state.generation++;connection.emit('invalidate');finish({frame:{frameId:'late'}});await expect(pending).rejects.toThrow();}finally{controls.dispose();}
});
it('returns control only on explicit release and prevents concurrent input',async()=>{
 const{connection,request}=fixture(),controls=new DesktopBrowserControls(connection,async()=>true);try{const opened=await controls.open('session:s',reference);let finish!:(value:any)=>void;request.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const pending=controls.frame(opened.id);await expect(controls.frame(opened.id)).rejects.toThrow('settling');await expect(controls.release(opened.id)).rejects.toThrow('settling');finish({frame:{frameId:'f'}});await pending;await controls.release(opened.id);expect(request.mock.calls.at(-1)![0].command.action).toBe('release');}finally{controls.dispose();}
});
it('opens an empty supported workspace with consent and tracks runtime generated session IDs',async()=>{
 const{connection,request}=fixture();
 request.mockImplementation(async({command}:any)=>({lease:{id:'private-lease',generation:1},state:'human',frame:null,workspace:{supported:true,reason:null,truncated:false,sessions:[],...(command.action==='workspace'?{selectedSessionId:'runtime-created'}:{})}}) as any);
 const controls=new DesktopBrowserControls(connection,async()=>true);
 try{const opened=await controls.open('session:s');await controls.workspace(opened.id,{kind:'create',url:'https://example.com'});await controls.workspace(opened.id,{kind:'list'});
 expect(request.mock.calls.map(([v])=>v.command.action)).toEqual(['inventory','acquire','workspace','workspace']);expect(request.mock.calls.at(-1)![0].command.browserId).toBe('runtime-created');
 await controls.release(opened.id);expect(request.mock.calls.at(-1)![0].command.browserId).toBe('runtime-created');
 }finally{controls.dispose();}
});
it('collects sign-in only in the protected Main callback and returns metadata',async()=>{
 const{connection,request}=fixture();request.mockImplementation(async({command}:any)=>({lease:{id:'private-lease',generation:1},frame:null,state:'human',...(command.action==='signin-prepare'?{entry:{id:'entry',origin:'https://example.com'}}:{})}) as any);
 const collect=vi.fn(async(_entry:any,deliver:(value:string)=>Promise<void>)=>{await deliver('fixture-secret');return true;});
 const secretPipe=vi.fn(async(_params:any)=>{}),controls=new DesktopBrowserControls(connection,async()=>true,collect,secretPipe);
 try{const opened=await controls.open('session:s',reference);expect(await controls.signIn(opened.id,'f','@e3','password')).toEqual({submitted:true});
 expect(collect.mock.calls[0]![0]).toEqual({origin:'https://example.com',kind:'password'});expect(request.mock.calls.map(([v])=>v.command.action)).toEqual(['acquire','signin-prepare','signin-cancel']);
 expect(secretPipe.mock.calls[0]![0].command).toMatchObject({entryId:'entry',value:'fixture-secret',sequence:2});expect(JSON.stringify(request.mock.calls)).not.toContain('fixture-secret');
 }finally{controls.dispose();}
});
