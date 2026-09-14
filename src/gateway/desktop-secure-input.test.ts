import {expect,it,vi} from 'vitest';
import {DesktopSecureInput} from './desktop-secure-input.js';
import {SecureInputCoordinator} from '../runtime/secure-input-coordinator.js';
import {EphemeralSecretBroker} from '../security/ephemeral-secret-broker.js';
import {SecureInputTransportRegistry} from '../security/secure-input-transport-registry.js';
import {validatePrivateControlRequest} from '../contracts/control-protocol.js';
import type {SecureInputRequest} from '../contracts/secure-input.js';
const binding={sessionId:'s',targetId:'t',targetGeneration:1};
const scope={profileId:'p',sessionId:'s',userId:'u'};
const request:SecureInputRequest={kind:'password',purpose:'Sign in',retention:'use-once',destination:{type:'browser-field',sessionId:'b',tabRef:'tab',frameId:'main',ref:'password',expectedOrigin:'https://example.com',label:'Password'}};
function fixture(profileId='p'){
 const input=new DesktopSecureInput(profileId),broker=new EphemeralSecretBroker(),transports=new SecureInputTransportRegistry(),events:string[]=[],values:Uint8Array[]=[];
 transports.register({id:'browser',destinationTypes:['browser-field'],priority:100,verificationStrength:'field-bound',persistence:'none',disclosureBoundary:'destination',requiresApproval:false,isAvailable:()=>true,
 verify:({request,phase})=>{events.push(phase+':'+request.kind);return{status:'verified',destination:request.destination};},deliver:async({value,context,consume})=>{events.push('deliver:'+context.request.kind);values.push(value);await consume(value,context);}});
 const abort=new AbortController(),coordinator=new SecureInputCoordinator({broker,transports,collect:input.collector(binding)});
 const handler=coordinator.createRequestHandler(scope,abort.signal);
 const pending=()=>input.handle(binding,{action:'pending',holder:'window'}).request;
 const deliver=async(value:string)=>{await vi.waitFor(()=>expect(pending()).not.toBeNull());const entry=pending()!;input.handle(binding,{action:'claim',holder:'window',requestId:entry.id});const command={action:'deliver' as const,holder:'window',requestId:entry.id,value};expect(input.handle(binding,command)).toEqual({request:null});expect(command.value).toBe('');return entry;};
 return{input,broker,events,values,abort,handler,pending,deliver,close:()=>{input.close();broker.dispose();}};
}
it('delivers grouped fields only after all input and renewed destination checks, with metadata-only receipts',async()=>{
 const f=fixture(),seen:string[]=[];
 try{const result=f.handler.requestGroup({purpose:'Sign in',items:[{id:'account',request:{...request,kind:'account-identifier'},consume:async v=>{seen.push(Buffer.from(v).toString());}},{id:'password',request,consume:async v=>{seen.push(Buffer.from(v).toString());}}]});
  const first=await f.deliver('account-canary');expect(first).toMatchObject({position:1,total:2,origin:'https://example.com'});expect(seen).toEqual([]);
  const second=await f.deliver('password-canary');expect(second.position).toBe(2);const receipt=await result;expect(receipt.status).toBe('delivered');expect(seen).toEqual(['account-canary','password-canary']);
  expect(f.events).toEqual(['before-collection:account-identifier','before-collection:password','before-delivery:account-identifier','before-delivery:password','deliver:account-identifier','deliver:password']);
  expect(f.values.every(v=>v.every(b=>b===0))).toBe(true);expect(JSON.stringify([first,second,receipt])).not.toContain('canary');
  expect(()=>f.input.handle(binding,{action:'deliver',holder:'window',requestId:first.id,value:'replay'})).toThrow();
 }finally{f.close();}
});
it('fences claims by target generation, Session and window; cancellation never delivers',async()=>{
 const f=fixture(),consume=vi.fn();try{const result=f.handler(request,consume);await vi.waitFor(()=>expect(f.pending()).not.toBeNull());const entry=f.pending()!;
 for(const other of [{...binding,sessionId:'other'},{...binding,targetGeneration:2},{...binding,targetId:'other'}])expect(()=>f.input.handle(other,{action:'claim',holder:'window',requestId:entry.id})).toThrow();
 expect(()=>f.input.handle(binding,{action:'deliver',holder:'window',requestId:entry.id,value:'unclaimed'})).toThrow();
 f.input.handle(binding,{action:'claim',holder:'window',requestId:entry.id});expect(f.input.handle(binding,{action:'pending',holder:'other'})).toEqual({request:null});expect(()=>f.input.handle(binding,{action:'claim',holder:'other',requestId:entry.id})).toThrow();
 f.input.handle(binding,{action:'cancel',holder:'window',requestId:entry.id});expect((await result).status).toBe('cancelled');expect(consume).not.toHaveBeenCalled();expect(f.pending()).toBeNull();
 }finally{f.close();}
});
it('rejects another profile and clears pending requests on abort or host shutdown',async()=>{
 const wrong=fixture('other');try{expect((await wrong.handler(request,vi.fn())).status).toBe('cancelled');expect(wrong.pending()).toBeNull();}finally{wrong.close();}
 for(const cancel of ['abort','close']){const f=fixture();try{const result=f.handler(request,vi.fn());await vi.waitFor(()=>expect(f.pending()).not.toBeNull());if(cancel==='abort')f.abort.abort();else f.input.close();expect((await result).status).toBe('cancelled');expect(f.pending()).toBeNull();}finally{f.close();}}
});
it('does not allow protected values to hitchhike in persisted control methods',()=>{
 const base={...binding,operationId:'o',workInput:{action:'deliver',holder:'w',requestId:'r',value:'canary'}};
 expect(()=>validatePrivateControlRequest({...base,method:'secure.input'})).not.toThrow();
 for(const method of ['send','inspect','cancel'])expect(()=>validatePrivateControlRequest({...base,method,text:'hello'})).toThrow();
 expect(()=>validatePrivateControlRequest({...base,method:'secure.input',text:'extra'})).toThrow();
});
it('expires unanswered input without delivering or leaving a claim',async()=>{
 vi.useFakeTimers();const f=fixture(),consume=vi.fn();try{const result=f.handler(request,consume);await vi.waitFor(()=>expect(f.pending()).not.toBeNull());const entry=f.pending()!;f.input.handle(binding,{action:'claim',holder:'window',requestId:entry.id});await vi.advanceTimersByTimeAsync(120001);expect((await result).status).not.toBe('delivered');expect(consume).not.toHaveBeenCalled();expect(f.pending()).toBeNull();}finally{f.close();vi.useRealTimers();}
});
