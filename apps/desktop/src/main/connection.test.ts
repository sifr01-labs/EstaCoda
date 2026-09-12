import{EventEmitter}from'node:events';
import{afterEach,expect,it,vi}from'vitest';
const controls=vi.hoisted(()=>({fail:false,clients:[] as any[],lookup:null as null|((work:unknown)=>void)}));
vi.mock('./protocol-client.js',()=>({ProtocolClient:class extends EventEmitter{
 context={capabilities:{events:[],methods:[]}};profile='default';closed=false;
 constructor(){super();controls.clients.push(this);}
 async request(method:string,params:any){
  if(method==='control.initialize'){this.profile=params.profileId;return{};}
  if(controls.fail)throw Error('Unavailable');
  if(method==='work.get')return new Promise(resolve=>{controls.lookup=resolve;});
  if(method==='control.bootstrap')return{profile:{id:this.profile,label:this.profile,configuration:'ready'},runtime:{state:'ready'},cursor:{sequence:0}};
  if(method==='control.subscribe')return{state:'subscribed'};
  if(method==='work.list'){const start=Number(params.cursor??0);return{items:Array.from({length:100},(_,i)=>({id:`${this.profile}-${start+i}`,profileId:this.profile})),nextCursor:start<200?String(start+100):null};}
  return{items:[],nextCursor:null};
 }
 dispose(){this.closed=true;}
}}));
import{DesktopConnection}from'./connection.js';import type{ServiceProcess}from'./service-process.js';
const create=()=>{const service=Object.assign(new EventEmitter(),{start:vi.fn(()=>({input:{},output:{},credentials:{}})),stop:vi.fn()});return{service,connection:new DesktopConnection(service as unknown as ServiceProcess)};};
afterEach(()=>{controls.fail=false;controls.lookup=null;controls.clients.length=0;vi.useRealTimers();});
it('keeps inspected pages across refresh and clears them on profile changes',async()=>{
 const{connection}=create();try{connection.switchProfile('default');await vi.waitFor(()=>expect(connection.state.status).toBe('ready'));await connection.more('work');expect(connection.state.work.items).toHaveLength(200);const before=connection.state;controls.clients[0].emit('event',{type:'work.changed'});await vi.waitFor(()=>expect(connection.state).not.toBe(before));expect(connection.state.work.items).toHaveLength(200);connection.switchProfile('other');expect(connection.state.work.items).toEqual([]);await vi.waitFor(()=>expect(connection.state.status).toBe('ready'));expect(connection.state.work.items.every(item=>item.profileId==='other')).toBe(true);expect(controls.clients[0].closed).toBe(true);}finally{connection.close();}
});
it('backs off repeated bootstrap failures rather than resetting retries after a failed refresh',async()=>{
 vi.useFakeTimers();controls.fail=true;const{connection,service}=create();try{connection.switchProfile('default');await vi.advanceTimersByTimeAsync(0);expect(connection.state.status).toBe('unavailable');expect(service.start).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(500);expect(service.start).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(500);expect(service.start).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(500);expect(service.start).toHaveBeenCalledTimes(3);connection.close();await vi.advanceTimersByTimeAsync(30000);expect(service.start).toHaveBeenCalledTimes(3);}finally{connection.close();}
});

it('reads off-page Work and rejects a late reply after a profile switch',async()=>{
 const{connection}=create();try{
  connection.switchProfile('default');await vi.waitFor(()=>expect(connection.state.status).toBe('ready'));
  const first=connection.getWork('old');controls.lookup!({id:'old',profileId:'default'});
  await expect(first).resolves.toMatchObject({id:'old'});
  const late=connection.getWork('old');const rejected=expect(late).rejects.toThrow('Desktop context changed');
  connection.switchProfile('other');controls.lookup!({id:'old',profileId:'default'});await rejected;
 }finally{connection.close();}
});
