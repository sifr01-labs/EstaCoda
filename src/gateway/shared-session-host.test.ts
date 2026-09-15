import { expect, it, vi } from "vitest";
import { SharedSessionHost } from "./shared-session-host.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { SessionDB } from "../contracts/session.js";

it("keeps priority cancellation reachable while a hosted turn waits", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const runtime = { sessionId: "session", dispose: vi.fn(async () => undefined),
    handle: vi.fn(async (input) => { started(); await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true })); return { text: "cancelled" }; }) } as unknown as Runtime;
  const sessionDb = { getSessionForProfile: vi.fn(async () => ({ id: "session", executionTarget: { targetId: "target" } })) } as unknown as SessionDB;
  const host = new SharedSessionHost({ profileId: "default", sessionDb, acquire: async () => runtime, channelApproval: vi.fn() });
  const base = { sessionId: "session", targetId: "target", operationId: "op" };
  const turn = host.handle({ ...base, method: "send", text: "work" });
  await running;
  await expect(host.handle({ ...base, method: "cancel" })).resolves.toEqual({ cancellationRequested: true, terminationConfirmed: false });
  await expect(turn).resolves.toMatchObject({ text: "cancelled" });
  expect(runtime.dispose).toHaveBeenCalledOnce();
  await host.close();
});
it("rejects target mismatch before runtime construction or channel approval", async () => {
  const acquire = vi.fn(), channelApproval = vi.fn();
  const host = new SharedSessionHost({ profileId: "default", acquire, channelApproval,
    sessionDb: { getSessionForProfile: async () => ({ executionTarget: { targetId: "other" } }) } as unknown as SessionDB });
  await expect(host.handle({ method: "send", sessionId: "s", targetId: "t", operationId: "o", text: "work" })).rejects.toThrow("target");
  expect(acquire).not.toHaveBeenCalled(); expect(channelApproval).not.toHaveBeenCalled();
});

it("routes priority channel cancellation and never invents termination confirmation", async () => {
  const channelCancel = vi.fn((id: string) => id === "session");
  const host = new SharedSessionHost({ profileId: "default", channelCancel, acquire: vi.fn(), channelApproval: vi.fn(),
    sessionDb: { getSessionForProfile: async () => ({ executionTarget: { targetId: "target" } }) } as unknown as SessionDB });
  await expect(host.handle({ method: "cancel", sessionId: "session", targetId: "target", operationId: "op" }))
    .resolves.toEqual({ cancellationRequested: true, terminationConfirmed: false });
  await expect(host.handle({ method: "cancel", sessionId: "foreign", targetId: "target", operationId: "op2" }))
    .resolves.toEqual({ cancellationRequested: false, terminationConfirmed: false });
  expect(channelCancel).toHaveBeenCalledWith("session");
  await host.close();
});
it('requires trusted generation validation before Desktop runtime construction', async () => {
  const acquire = vi.fn(), validateTarget = vi.fn(async () => { throw new Error('Target was archived'); });
  const sessionDb = { getSessionForProfile: async () => ({ executionTarget: { targetId: 'target', targetGeneration: 2 } }) } as unknown as SessionDB;
  const request = { method: 'send' as const, sessionId: 's', targetId: 'target', targetGeneration: 2, operationId: 'op', text: 'work' };
  const host = new SharedSessionHost({ profileId: 'p', acquire, sessionDb, validateTarget, channelApproval: vi.fn() });
  await expect(host.handle({ ...request, targetGeneration: 1 })).rejects.toThrow('generation');
  expect(validateTarget).not.toHaveBeenCalled();
  await expect(host.handle(request)).rejects.toThrow('archived'); expect(acquire).not.toHaveBeenCalled();
  const legacy = new SharedSessionHost({ profileId: 'p', acquire, sessionDb, channelApproval: vi.fn() });
  await expect(legacy.handle(request)).rejects.toThrow('generation');
});

it('defers model changes until a shared turn disposes without blocking cancellation',async()=>{
 let started!:()=>void;const running=new Promise<void>(resolve=>started=resolve);
 const order:string[]=[];
 const runtime={sessionId:'s',handle:async(input:any)=>{started();await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));return {text:'done'};},dispose:async()=>{order.push('disposed');}} as unknown as Runtime;
 const host=new SharedSessionHost({profileId:'p',sessionDb:{getSessionForProfile:async()=>({executionTarget:{targetId:'t'}})} as unknown as SessionDB,acquire:async()=>runtime,channelApproval:vi.fn(),modelControl:async()=>{order.push('changed');return {effective:'next_turn'};}});
 const base={sessionId:'s',targetId:'t',operationId:'op'};
 const turn=host.handle({...base,method:'send',text:'work'});await running;
 const change=host.handle({...base,method:'model',selection:null});await Promise.resolve();expect(order).toEqual([]);
 await host.handle({...base,method:'cancel'});await turn;await change;expect(order).toEqual(['disposed','changed']);await host.close();
});

it('exposes a bounded ephemeral assistant preview, clears it at tool boundaries, and drops it after settlement',async()=>{
 let input:any;let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
 const runtime={sessionId:'s',dispose:async()=>{},handle:async(value:any)=>{input=value;started();await new Promise<void>(resolve=>release=resolve);return{text:'settled'};}} as unknown as Runtime;
 const host=new SharedSessionHost({profileId:'p',sessionDb:{getSessionForProfile:async()=>({executionTarget:{targetId:'t'}})} as unknown as SessionDB,acquire:async()=>runtime,channelApproval:vi.fn()});
 const base={sessionId:'s',targetId:'t',operationId:'turn'};const turn=host.handle({...base,method:'send',text:'Work'});await ready;
 input.onDelta('x'.repeat(17000));const first=await host.handle({...base,method:'inspect'}) as any;expect(first.preview.text).toHaveLength(16384);expect(first.preview.truncated).toBe(true);
 await input.onEvent({kind:'provider-tool-call'});expect(await host.handle({...base,method:'inspect'})).toMatchObject({preview:{text:'',truncated:false}});
 input.onDelta('After tool');expect(await host.handle({...base,method:'inspect'})).toMatchObject({preview:{text:'After tool'}});
 release();await turn;expect(await host.handle({...base,method:'inspect'})).toMatchObject({active:false,preview:undefined});await host.close();
});

it('routes human browser control directly to the existing owner without receipts or runtime acquisition',async()=>{
 const acquire=vi.fn(),browserControl=vi.fn(async()=>({state:'human',lease:{id:'lease',generation:1},frame:null}));
 const host=new SharedSessionHost({profileId:'p',sessionDb:{getSessionForProfile:async()=>({executionTarget:{targetId:'t',targetGeneration:1}})} as unknown as SessionDB,acquire,channelApproval:vi.fn(),validateTarget:async()=>{},browserControl});
 const request={method:'browser.control' as const,sessionId:'s',targetId:'t',targetGeneration:1,operationId:'o',browserControl:{action:'acquire' as const,browserId:'b',holder:'w'}};
 await expect(host.handle(request)).resolves.toHaveProperty('state','human');expect(browserControl).toHaveBeenCalledTimes(1);expect(acquire).not.toHaveBeenCalled();
 await expect(host.handle({...request,targetGeneration:2})).rejects.toThrow();expect(browserControl).toHaveBeenCalledTimes(1);
});
it('drains accepted human browser input before closing the supervisor host',async()=>{
 let finish!:(value:unknown)=>void;const browserControl=vi.fn(()=>new Promise(resolve=>finish=resolve));
 const host=new SharedSessionHost({profileId:'p',sessionDb:{getSessionForProfile:async()=>({executionTarget:{targetId:'t',targetGeneration:1}})} as unknown as SessionDB,acquire:vi.fn(),channelApproval:vi.fn(),validateTarget:async()=>{},browserControl});
 const pending=host.handle({method:'browser.control',sessionId:'s',targetId:'t',targetGeneration:1,operationId:'o',browserControl:{action:'acquire',browserId:'b',holder:'w'}});await vi.waitFor(()=>expect(browserControl).toHaveBeenCalled());let closed=false;const shutdown=host.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);finish({state:'human'});await pending;await shutdown;expect(closed).toBe(true);
});

it('connects hosted secure input to the coordinator without queuing or persisting credential controls',async()=>{
 const {SecureInputCoordinator}=await import('../runtime/secure-input-coordinator.js');const {EphemeralSecretBroker}=await import('../security/ephemeral-secret-broker.js');const {SecureInputTransportRegistry}=await import('../security/secure-input-transport-registry.js');
 const broker=new EphemeralSecretBroker(),transports=new SecureInputTransportRegistry(),consume=vi.fn(async(value:Uint8Array)=>{expect(Buffer.from(value).toString()).toBe('private-canary');});
 transports.register({id:'browser',destinationTypes:['browser-field'],priority:1,verificationStrength:'field-bound',persistence:'none',disclosureBoundary:'destination',requiresApproval:false,isAvailable:()=>true,verify:({request})=>({status:'verified',destination:request.destination}),deliver:async({value,context,consume})=>consume(value,context)});
 const factory=vi.fn((options:any)=>new SecureInputCoordinator({broker,transports,collect:options.collect}).createRequestHandler({profileId:'p',sessionId:'s',userId:'operator'},options.signal));
 const runtime={sessionId:'s',createSecureInputRequestHandler:factory,dispose:async()=>{},handle:async(input:any)=>{const receipt=await input.onSecureInputRequest({kind:'password',purpose:'Sign in',retention:'use-once',destination:{type:'browser-field',sessionId:'b',tabRef:'tab',frameId:'main',ref:'password',expectedOrigin:'https://example.com',label:'Password'}},consume);return{text:JSON.stringify(receipt)};}} as unknown as Runtime;
 const host=new SharedSessionHost({profileId:'p',sessionDb:{getSessionForProfile:async()=>({executionTarget:{targetId:'t',targetGeneration:1}})} as unknown as SessionDB,validateTarget:async()=>{},acquire:async()=>runtime,channelApproval:vi.fn()});
 const base={sessionId:'s',targetId:'t',targetGeneration:1,operationId:'op'};
 try{const turn=host.handle({...base,method:'send',text:'Sign in'});let request:any;await vi.waitFor(async()=>{request=(await host.handle({...base,method:'secure.input',workInput:{action:'pending',holder:'w'}}) as any).request;expect(request).not.toBeNull();});
 const accept=vi.fn(()=>{throw new Error('Must not persist secure input');}),inspect=vi.fn(()=>[]);host.options.receipts={accept,inspect} as any;
 await host.handle({...base,method:'secure.input',workInput:{action:'claim',holder:'w',requestId:request.id}});
 const delivered=await host.handle({...base,method:'secure.input',workInput:{action:'deliver',holder:'w',requestId:request.id,value:'private-canary'}});
 const response=await turn;expect(factory).toHaveBeenCalledOnce();expect(consume).toHaveBeenCalledOnce();expect(accept).not.toHaveBeenCalled();expect(JSON.stringify([response,delivered,request])).not.toContain('private-canary');
 }finally{await host.close();broker.dispose();}
});

it('aborts the hosted input lifetime before releasing a normally settled turn',async()=>{
 let signal!:AbortSignal;
 const runtime={sessionId:'s',handle:async(input:any)=>{signal=input.signal;return{text:'done'};},dispose:vi.fn(async()=>{expect(signal.aborted).toBe(true);})} as unknown as Runtime;
 const host=new SharedSessionHost({profileId:'p',sessionDb:{getSessionForProfile:async()=>({executionTarget:{targetId:'t'}})} as unknown as SessionDB,acquire:async()=>runtime,channelApproval:vi.fn()});
 try{await expect(host.handle({method:'send',sessionId:'s',targetId:'t',operationId:'o',text:'hello'})).resolves.toMatchObject({text:'done'});expect(runtime.dispose).toHaveBeenCalledOnce();}finally{await host.close();}
});

it('reconnects shared connectors without dispatching a prompt and reports progress', async () => {
  let finish!: () => void;
  const reload = vi.fn(() => new Promise<never[]>(resolve => { finish=()=>resolve([]); }));
  const runtime = { reconnectMcpServers: reload, handle: vi.fn(), dispose: vi.fn(async()=>{}) } as unknown as Runtime;
  const acquire = vi.fn(async()=>runtime);
  const host = new SharedSessionHost({profileId:'p',acquire,channelApproval:vi.fn(),inspectConnectors:()=>[],validateTarget:async()=>{},
    sessionDb:{getSessionForProfile:async()=>({executionTarget:{targetId:'t',targetGeneration:1}})} as unknown as SessionDB});
  const base={sessionId:'s',targetId:'t',targetGeneration:1,operationId:'o'};
  await expect(host.handle({...base,method:'mcp.control',connectorAction:'inspect'})).resolves.toMatchObject({state:'ready'});
  expect(acquire).not.toHaveBeenCalled();
  await expect(host.handle({...base,method:'send',text:'/reload-mcp'})).resolves.toMatchObject({state:'reconnecting'});
  await vi.waitFor(()=>expect(reload).toHaveBeenCalledOnce());
  await expect(host.handle({...base,method:'mcp.control',connectorAction:'reconnect'})).resolves.toMatchObject({state:'reconnecting'});
  expect(reload).toHaveBeenCalledOnce(); expect(runtime.handle).not.toHaveBeenCalled();
  finish(); await vi.waitFor(()=>expect(host.hasPendingWork()).toBe(false));
  await expect(host.handle({...base,method:'mcp.control',connectorAction:'inspect'})).resolves.toMatchObject({state:'ready'});
  expect(runtime.dispose).toHaveBeenCalledOnce();
  await expect(host.handle({...base,targetGeneration:2,method:'mcp.control',connectorAction:'reconnect'})).rejects.toThrow('generation');
  expect(reload).toHaveBeenCalledOnce(); await host.close();
});
it('refuses connector restart during an active turn and keeps cancellation available', async () => {
  let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
  const reload=vi.fn();
  const runtime={reconnectMcpServers:reload,dispose:async()=>{},handle:async(input:any)=>{started();await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));return {text:'stopped'};}} as unknown as Runtime;
  const host=new SharedSessionHost({profileId:'p',acquire:async()=>runtime,channelApproval:vi.fn(),inspectConnectors:()=>[],sessionDb:{getSessionForProfile:async()=>({executionTarget:{targetId:'t'}})} as unknown as SessionDB});
  const base={sessionId:'s',targetId:'t',operationId:'o'};const turn=host.handle({...base,method:'send',text:'work'});await ready;
  await expect(host.handle({...base,method:'mcp.control',connectorAction:'reconnect'})).resolves.toMatchObject({state:'busy'});
  expect(reload).not.toHaveBeenCalled();await host.handle({...base,method:'cancel'});await turn;await host.close();
});

it('uses initial discovery once for a cold session and reports a failed refresh without model replay',async()=>{
 let loaded=false,fail=false;
 const runtime={reconnectMcpServers:vi.fn(async()=>{if(fail)throw new Error('private diagnostic');return[];}),handle:vi.fn(),dispose:async()=>{}} as unknown as Runtime;
 const host=new SharedSessionHost({profileId:'p',acquire:async()=>{loaded=true;return runtime;},inspectConnectors:()=>loaded?[]:undefined,channelApproval:vi.fn(),sessionDb:{getSessionForProfile:async()=>({executionTarget:{targetId:'t'}})} as unknown as SessionDB});
 const request={method:'mcp.control' as const,connectorAction:'reconnect' as const,sessionId:'s',targetId:'t',operationId:'o'};
 await host.handle(request);await vi.waitFor(()=>expect(host.hasPendingWork()).toBe(false));expect(runtime.reconnectMcpServers).not.toHaveBeenCalled();
 fail=true;await host.handle(request);await vi.waitFor(()=>expect(host.hasPendingWork()).toBe(false));
 const status=await host.handle({...request,connectorAction:'inspect'});expect(status).toMatchObject({state:'failed'});expect(JSON.stringify(status)).not.toContain('private diagnostic');expect(runtime.handle).not.toHaveBeenCalled();await host.close();
});
