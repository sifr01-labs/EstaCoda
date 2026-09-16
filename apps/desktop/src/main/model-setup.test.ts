import {mkdtempSync,rmSync} from 'node:fs';
import {WorkOperationReferences} from './work-operation-references.js';
import {EventEmitter} from 'node:events';
import {it,expect,vi,afterEach} from 'vitest';
import {DesktopModelSetup} from './model-setup.js';
const directories:string[]=[];afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const route={providerId:'kimi',modelId:'m',endpoint:'https://api.moonshot.ai/v1',apiMode:'openai_chat_completions' as const,authMethod:'api_key' as const,allowPrivateEndpoint:false};
function fixture(){
 const calls:any[]=[];const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1},modelRequest:vi.fn(async(method:string,params:any)=>{calls.push({method,params});return method==='models.reviewPrimary'?{draftId:'draft',role:'primary',route,expiresInMs:300000,credentialState:'staged'}:method==='models.applyDraft'?{operationId:'draft',state:'applied',verification:'configured'}:method==='models.cancelDraft'?{cancelled:true}:{valid:true};})});
 const directory=mkdtempSync('/tmp/ec-model-references-');directories.push(directory);const references=new WorkOperationReferences(connection as any,directory);
 const pipe={closeWindow:vi.fn(async()=>{})};const credentials={open:vi.fn((_pipe,scope,accepted)=>accepted('candidate')),close:vi.fn()};
 return {calls,connection,pipe,credentials,references,setup:new DesktopModelSetup(connection as any,credentials as any,()=>pipe as any,references)};
}
it('binds private entry and reviewed Apply to Main-owned identity and retains a reconciliation pointer',async()=>{
 const f=fixture();const {setupId}=await f.setup.begin(route);await f.setup.stage(setupId);await f.setup.review(setupId);expect(await f.setup.apply(setupId)).toMatchObject({state:'applied'});
 const scope=f.credentials.open.mock.calls[0]![1];const reviewed=f.calls.find(c=>c.method==='models.reviewPrimary').params;
 expect(reviewed).toEqual({windowId:scope.windowId,generation:scope.generation,route,candidateId:'candidate'});expect(f.pipe.closeWindow).toHaveBeenCalledWith(scope.windowId,scope.generation);
 await f.setup.inspect();expect(f.calls.at(-1)).toEqual({method:'models.inspectApply',params:{operationId:'draft'}});
});
it('cancels staged keys and refuses stale setup IDs after profile invalidation',async()=>{
 const f=fixture();const {setupId}=await f.setup.begin(route);await f.setup.stage(setupId);expect(await f.setup.cancel(setupId)).toEqual({cancelled:true});expect(f.pipe.closeWindow).toHaveBeenCalledOnce();
 const next=await f.setup.begin(route);f.connection.state={profileId:'other',generation:2};f.connection.emit('invalidate');await expect(f.setup.review(next.setupId)).rejects.toThrow('Setup changed');
 f.connection.modelRequest.mockResolvedValueOnce({operationId:'none',state:'unknown',verification:'not_tested'} as any);expect(await f.setup.inspect()).toBeNull();expect(f.calls.some(c=>c.method==='models.applyDraft')).toBe(false);
});
it('does not blindly resend an Apply after transport failure',async()=>{
 const f=fixture();const {setupId}=await f.setup.begin(route);await f.setup.stage(setupId);await f.setup.review(setupId);
 f.connection.modelRequest.mockImplementation(async(method:string)=>{if(method==='models.applyDraft')throw new Error('Disconnected');return {operationId:'draft',state:'uncertain',verification:'not_tested'} as any;});
 await expect(f.setup.apply(setupId)).rejects.toThrow('Disconnected');f.connection.emit('invalidate');expect(await f.setup.inspect()).toMatchObject({state:'uncertain'});
 expect(f.connection.modelRequest.mock.calls.filter(c=>c[0]==='models.applyDraft')).toHaveLength(1);
});
it('opens only the service-confirmed Codex URL and carries the authorized candidate into review',async()=>{
 const f=fixture(),open=vi.fn(async()=>{});const setup=new DesktopModelSetup(f.connection as any,f.credentials as any,()=>f.pipe as any,f.references,open);
 let authorized=false;f.connection.modelRequest.mockImplementation(async(method:string,params:any)=>{
  f.calls.push({method,params});if(method==='models.oauthStart'||method==='models.oauthStatus')return {authorizationId:'auth',state:authorized?'authorized':'pending',verificationUrl:authorized?null:'https://auth.openai.com/codex/device',userCode:authorized?null:'CODE',candidateId:authorized?'oauth-candidate':null} as any;
  return {valid:true,cancelled:true} as any;
 });
 const {setupId}=await setup.begin({...route,providerId:'codex',endpoint:'https://chatgpt.com/backend-api/codex',authMethod:'oauth',apiMode:'openai_responses'});
 await setup.oauthStart(setupId);await setup.oauthOpen(setupId);expect(open).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
 authorized=true;await setup.oauthStatus(setupId);await expect(setup.oauthOpen(setupId)).rejects.toThrow();await setup.review(setupId);expect(f.calls.at(-1).params.candidateId).toBe('oauth-candidate');
 expect(f.credentials.open).not.toHaveBeenCalled();await setup.cancel(setupId);expect(f.calls.some(c=>c.method==='models.oauthCancel')).toBe(true);
});
it('uses reviewed fallback and specialist service methods without exposing credentials',async()=>{
 const f=fixture();const {setupId}=await f.setup.begin(route);await f.setup.stage(setupId);
 await f.setup.review(setupId,{role:'fallback'});expect(f.calls.at(-1).method).toBe('models.reviewFallback');
 await f.setup.review(setupId,{role:'auxiliary',slot:'assessor',fallbackToMain:true});expect(f.calls.at(-1)).toMatchObject({method:'models.reviewAuxiliary',params:{slot:'assessor',fallbackToMain:true,candidateId:'candidate'}});
 await f.setup.cancel(setupId);
 f.connection.modelRequest.mockImplementation(async(method:string,params:any)=>{f.calls.push({method,params});return {draftId:'order',role:'fallback_order',expiresInMs:300000,credentialState:'not_required'} as any;});
 const reviewed=await f.setup.reviewed('models.reviewFallbackOrder',{revision:'rev',order:[1,0]});expect(reviewed.draft.role).toBe('fallback_order');expect(f.calls.at(-1)).toMatchObject({method:'models.reviewFallbackOrder',params:{revision:'rev',order:[1,0]}});
 expect(f.calls.filter(c=>c.method==='models.applyDraft')).toHaveLength(0);
});
it('resolves canonical Work bindings in Main and blocks resend until a previous override settles',async()=>{
 const f=fixture();Object.assign(f.connection,{getWork:vi.fn(async()=>({canonicalId:'task',profileId:'p',kind:'task',target:{targetId:'target',targetGeneration:3},modelBinding:{sessionId:'origin',taskId:'task'}}))});
 let state='accepted';f.connection.modelRequest.mockImplementation(async(method:string,params:any)=>{f.calls.push({method,params});return{...params,state} as any;});
 await f.setup.setOverride('task:task',{providerId:'kimi',modelId:'m'});expect(f.calls.at(-1)).toMatchObject({method:'tasks.setModel',params:{sessionId:'origin',taskId:'task',target:{targetId:'target',targetGeneration:3},selection:{providerId:'kimi',modelId:'m'}}});
 await expect(f.setup.setOverride('task:task',null)).rejects.toThrow('Reconcile');expect(f.calls.filter(c=>c.method==='tasks.setModel')).toHaveLength(1);
 state='completed';await f.setup.setOverride('task:task',null);expect(f.calls.at(-1).params.selection).toBeNull();expect(f.calls.filter(c=>c.method==='tasks.setModel')).toHaveLength(2);
 f.connection.state.profileId='other';await expect(f.setup.workOverride('task:task')).rejects.toThrow('unavailable');
});
it('rejects attempt Work and stale profile bindings before sending an override',async()=>{
 const f=fixture();Object.assign(f.connection,{getWork:vi.fn(async()=>({canonicalId:'attempt',profileId:'p',kind:'task_attempt',target:{targetId:'target',targetGeneration:3},modelBinding:{sessionId:'origin',taskId:'task'}}))});
 await expect(f.setup.setOverride('attempt:a',null)).rejects.toThrow('unavailable');expect(f.calls).toEqual([]);
});
it('serializes setup creation and drops late validation after cancellation or profile change',async()=>{
 for(const interrupt of ['cancel','profile']){const f=fixture();let release!:(value:any)=>void;f.connection.modelRequest.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));const pending=f.setup.begin(route);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));await expect(f.setup.begin(route)).rejects.toThrow('settling');if(interrupt==='cancel')await f.setup.cancel();else{f.connection.state={profileId:'other',generation:2};f.connection.emit('invalidate');}release({valid:true});await expect(pending).rejects.toThrow('changed');expect(f.credentials.open).not.toHaveBeenCalled();}
});
it('keeps an uncertain Apply blocking new setup until it is reconciled',async()=>{
 const f=fixture(),{setupId}=await f.setup.begin(route);await f.setup.review(setupId);f.connection.modelRequest.mockImplementation(async()=>({cancelled:false}) as any);
 expect(await f.setup.cancel(setupId)).toEqual({cancelled:false});await expect(f.setup.begin(route)).rejects.toThrow('Reconcile');
});

it('recovers pending model overrides across Main restart and keeps profile journals separate',async()=>{
 const f=fixture();Object.assign(f.connection,{getWork:async()=>({canonicalId:'s',profileId:f.connection.state.profileId,kind:'session',target:{targetId:'target',targetGeneration:1},modelBinding:{sessionId:'s'}})});
 let state='accepted';f.connection.modelRequest.mockImplementation(async(method:string,params:any)=>{f.calls.push({method,params});if(method==='sessions.setModel')throw new Error('Reply lost');return{...params,state} as any;});
 await expect(f.setup.setOverride('session:s',{providerId:'kimi',modelId:'m'})).rejects.toThrow('Reply lost');
 const restarted=new DesktopModelSetup(f.connection as any,f.credentials as any,()=>f.pipe as any,new WorkOperationReferences(f.connection as any,f.references.directory));
 expect(await restarted.inspectOverride('session:s')).toMatchObject({state:'accepted',method:'sessions.setModel'});
 await expect(restarted.setOverride('session:s',null)).rejects.toThrow('Reconcile');
 f.connection.state.profileId='q';expect(await restarted.inspectOverride('session:s')).toBeNull();
 f.connection.state.profileId='p';state='completed';expect(await restarted.inspectOverride('session:s')).toMatchObject({state:'completed'});
 expect(f.calls.filter(call=>call.method==='sessions.setModel')).toHaveLength(1);
});

it('uses provider registration instead of primary assignment when setup has no route role',async()=>{
 const f=fixture();const {setupId}=await f.setup.begin(route);await f.setup.stage(setupId);
 await f.setup.review(setupId,{role:'provider'});
 expect(f.calls.some(c=>c.method==='models.reviewProvider')).toBe(true);
 expect(f.calls.some(c=>c.method==='models.reviewPrimary')).toBe(false);
});

it('releases a reconciled saved setup so the next provider can be configured without replaying Apply',async()=>{
 const f=fixture();const {setupId}=await f.setup.begin(route);await f.setup.review(setupId);
 f.connection.modelRequest.mockImplementation(async(method:string)=>{if(method==='models.applyDraft')throw Error('Reply lost');if(method==='models.inspectApply')return {operationId:'draft',state:'applied',verification:'configured'} as any;return {valid:true,cancelled:false} as any;});
 await expect(f.setup.apply(setupId)).rejects.toThrow();expect(await f.setup.inspect()).toMatchObject({state:'applied'});
 await expect(f.setup.begin(route)).resolves.toHaveProperty('setupId');expect(f.connection.modelRequest.mock.calls.filter(c=>c[0]==='models.applyDraft')).toHaveLength(1);
});
