import {it,expect,vi} from 'vitest';
import {CredentialCandidates} from './credential-candidates.js';
import {TelegramVerifier,telegramScope} from './telegram-verification.js';
const input={homeDir:'/unused',profileId:'p'},scope=telegramScope({windowId:'w',generation:1}),token='123456:synthetic-private-token';
it('verifies only the fixed bot endpoint and never returns tokens or Telegram error text',async()=>{
 const candidates=new CredentialCandidates('p','bridge'),candidateId=candidates.stage(scope,token),params={windowId:'w',generation:1,candidateId};
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,result:{is_bot:true,username:'example_bot'}})));
 const verifier=new TelegramVerifier(input,candidates,fetcher);
 try{expect(await verifier.verify(params,new AbortController().signal)).toMatchObject({state:'passed',botUsername:'example_bot'});expect(verifier.verified(params)).toBe(true);expect(fetcher.mock.calls[0]).toMatchObject([`https://api.telegram.org/bot${token}/getMe`,{redirect:'error',method:'POST'}]);
 fetcher.mockResolvedValueOnce(new Response(token,{status:401}));const failed=await verifier.verify(params,new AbortController().signal);expect(failed.reason).toBe('invalid_credential');expect(JSON.stringify(failed)).not.toContain(token);expect(verifier.verified(params)).toBe(false);
 }finally{verifier.dispose();candidates.dispose();}
});
it('discards in-flight verification on window invalidation and rejects foreign candidates',async()=>{
 const candidates=new CredentialCandidates('p','bridge'),candidateId=candidates.stage(scope,token),params={windowId:'w',generation:1,candidateId};
 const fetcher=vi.fn((_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error(token)),{once:true})));
 const verifier=new TelegramVerifier(input,candidates,fetcher as typeof fetch);
 try{const pending=verifier.verify(params,new AbortController().signal);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());candidates.closeWindow('w',1);expect(await pending).toMatchObject({state:'failed',reason:'cancelled'});await expect(verifier.verify({...params,windowId:'foreign'},new AbortController().signal)).rejects.toThrow();}finally{verifier.dispose();candidates.dispose();}
});
it('bounds bot responses without returning provider-controlled contents',async()=>{
 const candidates=new CredentialCandidates('p','bridge'),candidateId=candidates.stage(scope,token),verifier=new TelegramVerifier(input,candidates,async()=>new Response('x'.repeat(65537)));
 try{expect(await verifier.verify({windowId:'w',generation:1,candidateId},new AbortController().signal)).toMatchObject({state:'failed',reason:'unavailable',botUsername:null});}finally{verifier.dispose();candidates.dispose();}
});
