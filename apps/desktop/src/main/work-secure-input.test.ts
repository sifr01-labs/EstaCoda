import {it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {DesktopConnection} from './connection.js';
import type {CredentialPipeClient} from './credential-pipe-client.js';
import {DesktopWorkInput} from './work-secure-input.js';
const entry={id:'one',kind:'password',origin:'https://example.com',position:1,total:1,expiresAt:new Date(Date.now()+60000).toISOString()};
function fixture(collect:(request:any,deliver:(value:string)=>Promise<void>)=>Promise<boolean>){
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready'}}) as DesktopConnection;
 const call=vi.fn(async(_workId:string,command:any)=>({request:command.action==='claim'||command.action==='pending'?entry:null})),pipe={workInput:call} as unknown as CredentialPipeClient,close=vi.fn();
 return{connection,call,close,input:new DesktopWorkInput(connection,()=>pipe,collect,close)};
}
it('keeps native values on the credential channel and cancels dismissed input',async()=>{
 const collect=vi.fn(async(_request,deliver)=>{await deliver('native-canary');return true;}),f=fixture(collect);
 try{await expect(f.input.open('session:s','one')).resolves.toBeUndefined();expect(f.call.mock.calls.map(([,c])=>c.action)).toEqual(['claim','deliver']);expect(collect.mock.calls[0]![0]).toEqual(entry);
 collect.mockImplementationOnce(async()=>false);await f.input.open('session:s','one');expect(f.call.mock.calls.at(-1)![1].action).toBe('cancel');}finally{f.input.dispose();}
});
it('cancels late claims after disconnect and never opens a stale credential window',async()=>{
 const collect=vi.fn(),f=fixture(collect);try{let finish!:(result:any)=>void;f.call.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const rejected=expect(f.input.open('session:s','one')).rejects.toThrow('disconnected');f.connection.emit('invalidate');finish({request:entry});await rejected;expect(collect).not.toHaveBeenCalled();expect(f.call.mock.calls.at(-1)![1].action).toBe('cancel');expect(f.close).toHaveBeenCalled();}finally{f.input.dispose();}
});
it('allows only one native flow and rejects delivery after profile invalidation',async()=>{
 let deliver!:(value:string)=>Promise<void>,finish!:(accepted:boolean)=>void;
 const f=fixture(async(_r,d)=>{deliver=d;return new Promise(resolve=>finish=resolve);});try{const opening=f.input.open('session:s','one');await vi.waitFor(()=>expect(deliver).toBeDefined());await expect(f.input.open('session:s','one')).rejects.toThrow('already open');f.connection.emit('invalidate');await expect(deliver('stale-canary')).rejects.toThrow('disconnected');finish(false);await opening;expect(f.call.mock.calls.some(([,c])=>c.action==='deliver')).toBe(false);}finally{f.input.dispose();}
});
it('collects the next grouped field only for matching verified metadata',async()=>{
 const f=fixture(async(_entry,deliver)=>{await deliver('canary');return true;});try{const first={...entry,total:2},second={...first,id:'two',position:2};let delivered=0;f.call.mockImplementation(async(_id,c)=>{if(c.action==='deliver'){delivered++;return{request:null};}return{request:delivered?second:first};});await f.input.open('session:s','one');expect(f.call.mock.calls.map(([,c])=>c.action)).toEqual(['claim','deliver','pending','claim','deliver']);}finally{f.input.dispose();}
});

it('closes an open credential window when its owner cancels, without waiting for expiry',async()=>{
 vi.useFakeTimers();let finish!:(accepted:boolean)=>void,deliver!:(value:string)=>Promise<void>;
 const f=fixture(async(_r,d)=>{deliver=d;return new Promise(resolve=>finish=resolve);});
 try{const opening=f.input.open('session:s','one');await vi.waitFor(()=>expect(deliver).toBeDefined());
  f.close.mockImplementation(()=>finish(false));f.call.mockImplementation(async()=>({request:null}));
  await vi.advanceTimersByTimeAsync(1000);await opening;expect(f.close).toHaveBeenCalledOnce();
  await expect(deliver('late-canary')).rejects.toThrow('expired');expect(f.call.mock.calls.some(([,c])=>c.action==='deliver')).toBe(false);
 }finally{f.input.dispose();vi.useRealTimers();}
});
it('ignores an old pending poll after delivery while the next grouped window is open',async()=>{
 let answerPoll!:(value:any)=>void,firstDeliver!:(value:string)=>Promise<void>,finishFirst!:(value:boolean)=>void,finishSecond!:(value:boolean)=>void;
 let count=0;const f=fixture(async(_r,d)=>{count++;if(count===1){firstDeliver=d;return new Promise(resolve=>finishFirst=resolve);}return new Promise(resolve=>finishSecond=resolve);});
 vi.useFakeTimers();try{const first={...entry,total:2},second={...first,id:'two',position:2};let delivered=false;
  f.call.mockImplementation(async(_id,c)=>{if(c.action==='deliver'){delivered=true;return{request:null};}if(c.action==='pending'&&!delivered)return new Promise(resolve=>answerPoll=resolve);return{request:delivered?second:first};});
  const opening=f.input.open('session:s','one');await vi.waitFor(()=>expect(firstDeliver).toBeDefined());await vi.advanceTimersByTimeAsync(1000);await firstDeliver('canary');finishFirst(true);
  await vi.waitFor(()=>expect(finishSecond).toBeDefined());answerPoll({request:null});await vi.advanceTimersByTimeAsync(0);expect(f.close).not.toHaveBeenCalled();finishSecond(false);await opening;
 }finally{f.input.dispose();vi.useRealTimers();}
});
