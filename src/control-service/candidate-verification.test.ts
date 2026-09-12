import {expect, it} from 'vitest';
import {CandidateVerifier,validateCandidateRequest} from './candidate-verification.js';
import {CredentialCandidates, type CandidateScope} from './credential-candidates.js';
import type {VerifyCandidateParams} from '../contracts/desktop-control/index.js';
const scope: CandidateScope = {windowId:'w',generation:1,purpose:'provider',providerId:'kimi',authMethod:'api_key',endpoint:'https://api.moonshot.ai/v1'};
function fixture() {
  const candidates=new CredentialCandidates('p','b');
  const candidateId=candidates.stage(scope,'synthetic-key-canary');
  const params: VerifyCandidateParams={windowId:'w',generation:1,candidateId,spendApproved:true,route:{providerId:'kimi',modelId:'kimi-k2',endpoint:scope.endpoint,authMethod:'api_key',apiMode:'openai_chat_completions',allowPrivateEndpoint:false}};
  return {candidates,params};
}
it('rejects public HTTP and cloud metadata even when private endpoints are selected',()=>{
  const {candidates,params}=fixture();try{
    for(const endpoint of ['http://example.com/v1','http://169.254.169.254/v1'])
      expect(()=>validateCandidateRequest({...params,route:{...params.route,endpoint,allowPrivateEndpoint:true}})).toThrow();
    expect(()=>candidates.stage(scope,'invalid\nheader')).toThrow();
  }finally{candidates.dispose();}
});
it('verifies one bounded stream without returning content or executing tool calls', async () => {
  const {candidates,params}=fixture(); let calls=0;
  const verifier=new CandidateVerifier(candidates,()=>async (_url,init)=>{
    calls++; expect(init.headers.Authorization ?? init.headers.authorization).toBe('Bearer synthetic-key-canary');
    expect(JSON.parse(init.body).max_tokens).toBe(64);
    const chunks=[{choices:[{delta:{tool_calls:[{index:0,id:'call',type:'function',function:{name:'verification_ping',arguments:'{}'}}]},finish_reason:null}]},
      {choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:3}}];
    const data=new TextEncoder().encode(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n');
    return {ok:true,status:200,statusText:'',json:async()=>({}),text:async()=>'',body:new ReadableStream({start(c){c.enqueue(data);c.close();}})};
  });
  try {
    const result=await verifier.verify(params,new AbortController().signal);
    expect(result).toMatchObject({state:'passed',streaming:true,tools:true,inputTokens:10,outputTokens:3});
    expect(calls).toBe(1);expect(JSON.stringify(result)).not.toContain('canary');
    expect(candidates.read(params.candidateId!,scope)).toBe('synthetic-key-canary');
  } finally {verifier.dispose();candidates.dispose();}
});
it('rejects endpoint rebinding and discards failed candidate credentials', async () => {
  const {candidates,params}=fixture();let calls=0;
  const verifier=new CandidateVerifier(candidates,()=>async ()=>{calls++;return {ok:false,status:401,statusText:'secret-response-canary',json:async()=>({}),text:async()=>''};});
  try {
    await expect(verifier.verify({...params,route:{...params.route,endpoint:'https://example.com/v1'}},new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(0);
    const result=await verifier.verify(params,new AbortController().signal);
    expect(result).toMatchObject({state:'failed',reason:'invalid_credential'});
    expect(JSON.stringify(result)).not.toContain('canary');
    expect(()=>candidates.read(params.candidateId!,scope)).toThrow();
  } finally {verifier.dispose();candidates.dispose();}
});
it('aborts an in-flight request when its credential window closes', async () => {
  const {candidates,params}=fixture();let started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const verifier=new CandidateVerifier(candidates,(_endpoint,_private,signal)=>async ()=>{
    started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    throw new Error('unreachable');
  });
  try {
    const running=verifier.verify(params,new AbortController().signal);await ready;
    await expect(verifier.verify(params,new AbortController().signal)).rejects.toThrow();
    candidates.closeWindow('w',1);
    expect(await running).toMatchObject({state:'cancelled'});
  } finally {verifier.dispose();candidates.dispose();}
});
it('uses only the staged OAuth access token for a Codex verification request',async()=>{
 const candidates=new CredentialCandidates('p','b');const oauthScope={...scope,providerId:'codex',authMethod:'oauth' as const,endpoint:'https://chatgpt.com/backend-api/codex'};
 const candidateId=candidates.stage(oauthScope,JSON.stringify({authMethod:'oauth_device_pkce',accessToken:'access-canary',refreshToken:'refresh-canary'}));
 let calls=0;const verifier=new CandidateVerifier(candidates,()=>async(_url,init)=>{calls++;expect(init.headers.authorization).toBe('Bearer access-canary');expect(JSON.stringify(init)).not.toContain('refresh-canary');return {ok:false,status:401,statusText:'',json:async()=>({}),text:async()=>''};});
 try{const result=await verifier.verify({windowId:'w',generation:1,candidateId,spendApproved:true,route:{providerId:'codex',modelId:'gpt-5.5',endpoint:oauthScope.endpoint,authMethod:'oauth',apiMode:'openai_responses',allowPrivateEndpoint:false}},new AbortController().signal);expect(calls).toBe(1);expect(result.reason).toBe('invalid_credential');}finally{verifier.dispose();candidates.dispose();}
});
