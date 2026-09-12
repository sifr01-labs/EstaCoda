import {afterEach,it,expect,vi} from 'vitest';
import {CodexAuthorization} from './codex-authorization.js';
import {CredentialCandidates} from './credential-candidates.js';
const scope={windowId:'w',generation:1,purpose:'provider' as const,providerId:'codex',authMethod:'oauth' as const,endpoint:'https://chatgpt.com/backend-api/codex'};
const json=(value:unknown)=>({ok:true,status:200,statusText:'',json:async()=>value});
afterEach(()=>vi.useRealTimers());
it('stages tokens only inside the bound service and exposes no authorization secrets',async()=>{
 vi.useFakeTimers();const candidates=new CredentialCandidates('p','b');
 const fetch=vi.fn(async(url:string)=>url.endsWith('usercode')?json({user_code:'CODE-123',device_auth_id:'private-device',interval:1}):url.endsWith('deviceauth/token')?json({authorization_code:'private-code',code_verifier:'private-verifier'}):json({access_token:'access-secret',refresh_token:'refresh-secret',expires_in:3600}));
 const oauth=new CodexAuthorization(candidates,()=>fetch);
 try{
  const initial=oauth.start(scope),binding={...scope,authorizationId:initial.authorizationId};
  await vi.advanceTimersByTimeAsync(0);expect(oauth.status(binding)).toMatchObject({state:'pending',userCode:'CODE-123'});
  await vi.advanceTimersByTimeAsync(1001);const status=oauth.status(binding);expect(status.state).toBe('authorized');
  expect(JSON.stringify(status)).not.toMatch(/access-secret|refresh-secret|private-/);
  expect(JSON.parse(candidates.read(status.candidateId!,scope))).toMatchObject({accessToken:'access-secret',refreshToken:'refresh-secret'});
  expect(()=>oauth.status({...binding,generation:2})).toThrow();
  oauth.cancel(binding);expect(()=>candidates.read(status.candidateId!,scope)).toThrow();
 }finally{oauth.dispose();candidates.dispose();}
});
it.each(['cancel','window','dispose'] as const)('discards a late token exchange after %s',async(reason)=>{
 vi.useFakeTimers();let finish!:(value:any)=>void;
 const candidates=new CredentialCandidates('p','b');const stage=vi.spyOn(candidates,'stage');
 const oauth=new CodexAuthorization(candidates,()=>async url=>url.endsWith('usercode')?json({user_code:'CODE',device_auth_id:'private',interval:1}):url.endsWith('deviceauth/token')?json({authorization_code:'code',code_verifier:'verifier'}):new Promise(resolve=>{finish=resolve;}));
 const initial=oauth.start(scope),binding={...scope,authorizationId:initial.authorizationId};
 await vi.advanceTimersByTimeAsync(1001);expect(finish).toBeDefined();
 if(reason==='cancel')oauth.cancel(binding);else if(reason==='window')candidates.closeWindow('w',1);else oauth.dispose();
 finish(json({access_token:'late-secret'}));await vi.advanceTimersByTimeAsync(0);expect(stage).not.toHaveBeenCalled();
 expect(()=>oauth.status(binding)).toThrow();oauth.dispose();candidates.dispose();
});
