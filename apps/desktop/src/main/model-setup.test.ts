import {EventEmitter} from 'node:events';
import {it,expect,vi} from 'vitest';
import {DesktopModelSetup} from './model-setup.js';
const route={providerId:'kimi',modelId:'m',endpoint:'https://api.moonshot.ai/v1',apiMode:'openai_chat_completions' as const,authMethod:'api_key' as const,allowPrivateEndpoint:false};
function fixture(){
 const calls:any[]=[];const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1},modelRequest:vi.fn(async(method:string,params:any)=>{calls.push({method,params});return method==='models.reviewPrimary'?{draftId:'draft',role:'primary',route,expiresInMs:300000,credentialState:'staged'}:method==='models.applyDraft'?{operationId:'draft',state:'applied',verification:'configured'}:method==='models.cancelDraft'?{cancelled:true}:{valid:true};})});
 const pipe={closeWindow:vi.fn(async()=>{})};const credentials={open:vi.fn((_pipe,scope,accepted)=>accepted('candidate')),close:vi.fn()};
 return {calls,connection,pipe,credentials,setup:new DesktopModelSetup(connection as any,credentials as any,()=>pipe as any)};
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
 expect(await f.setup.inspect()).toBeNull();expect(f.calls.some(c=>c.method==='models.applyDraft')).toBe(false);
});
it('does not blindly resend an Apply after transport failure',async()=>{
 const f=fixture();const {setupId}=await f.setup.begin(route);await f.setup.stage(setupId);await f.setup.review(setupId);
 f.connection.modelRequest.mockImplementation(async(method:string)=>{if(method==='models.applyDraft')throw new Error('Disconnected');return {operationId:'draft',state:'uncertain',verification:'not_tested'} as any;});
 await expect(f.setup.apply(setupId)).rejects.toThrow('Disconnected');f.connection.emit('invalidate');expect(await f.setup.inspect()).toMatchObject({state:'uncertain'});
 expect(f.connection.modelRequest.mock.calls.filter(c=>c[0]==='models.applyDraft')).toHaveLength(1);
});
it('opens only the service-confirmed Codex URL and carries the authorized candidate into review',async()=>{
 const f=fixture(),open=vi.fn(async()=>{});const setup=new DesktopModelSetup(f.connection as any,f.credentials as any,()=>f.pipe as any,open);
 let authorized=false;f.connection.modelRequest.mockImplementation(async(method:string,params:any)=>{
  f.calls.push({method,params});if(method==='models.oauthStart'||method==='models.oauthStatus')return {authorizationId:'auth',state:authorized?'authorized':'pending',verificationUrl:authorized?null:'https://auth.openai.com/codex/device',userCode:authorized?null:'CODE',candidateId:authorized?'oauth-candidate':null} as any;
  return {valid:true,cancelled:true} as any;
 });
 const {setupId}=await setup.begin({...route,providerId:'codex',endpoint:'https://chatgpt.com/backend-api/codex',authMethod:'oauth',apiMode:'openai_responses'});
 await setup.oauthStart(setupId);await setup.oauthOpen(setupId);expect(open).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
 authorized=true;await setup.oauthStatus(setupId);await expect(setup.oauthOpen(setupId)).rejects.toThrow();await setup.review(setupId);expect(f.calls.at(-1).params.candidateId).toBe('oauth-candidate');
 expect(f.credentials.open).not.toHaveBeenCalled();await setup.cancel(setupId);expect(f.calls.some(c=>c.method==='models.oauthCancel')).toBe(true);
});
