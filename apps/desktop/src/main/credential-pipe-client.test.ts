import { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { CredentialPipeClient } from './credential-pipe-client.js';
const scope={windowId:'window',generation:1,purpose:'provider' as const,providerId:'kimi',authMethod:'api_key' as const,endpoint:'https://api.moonshot.ai/v1'};
function fixture(){
 const frames: string[]=[];
 const pipe=new Duplex({read(){},write(chunk,_encoding,callback){frames.push(chunk.toString());callback();}});
 return{pipe,frames,client:new CredentialPipeClient(pipe)};
}
it('sends staged values only on the private pipe and accepts only opaque IDs',async()=>{
 const {client,pipe,frames}=fixture();const staged=client.stage(scope,'test-only-value');
 const request=JSON.parse(frames[0]!);expect(request.method).toBe('credentials.stage');expect(request.params.scope).toEqual(scope);
 pipe.push(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{candidateId:'candidate-1'}})+'\n');
 expect(await staged).toBe('candidate-1');client.dispose();
});
it('rejects a response containing secret material or an unknown ID',async()=>{
 const {client,pipe,frames}=fixture();const rejected=expect(client.stage(scope,'fixture-secret')).rejects.toThrow('Credential channel unavailable.');
 pipe.push(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(frames[0]!).id,result:{candidateId:'id',value:'fixture-secret'}})+'\n');
 await rejected;
});
it('drops in-flight candidates on disposal and bounds credential size',async()=>{
 const {client,frames}=fixture();await expect(client.stage(scope,'a'.repeat(49153))).rejects.toThrow();expect(frames).toHaveLength(0);
 const rejected=expect(client.stage(scope,'fixture')).rejects.toThrow();client.dispose();await rejected;
});
it('uses the dedicated pipe for browser sign-in and clears the caller value after delivery',async()=>{
 const{client,pipe,frames}=fixture(),params={workId:'session:s',command:{action:'signin-deliver' as const,browserId:'b',holder:'main',lease:{id:'l',generation:1},sequence:1,entryId:'entry',value:'secret-canary'}};
 const delivery=client.deliverBrowser(params),request=JSON.parse(frames[0]!);expect(request.method).toBe('credentials.browserDeliver');
 pipe.push(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{delivered:true}})+'\n');await delivery;expect(params.command.value).toBe('');client.dispose();
});
