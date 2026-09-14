import {expect,it,vi} from 'vitest';
import type {WorkProjection} from '../contracts/desktop-control/index.js';
const mocks=vi.hoisted(()=>({call:vi.fn(),owner:vi.fn()}));
vi.mock('../gateway/private-control.js',()=>({callPrivateControl:mocks.call}));
vi.mock('./browser-view.js',()=>({browserOwner:mocks.owner}));
import {WorkInputClaims,workInput} from './work-input.js';
const input={homeDir:'/tmp/fixture',profileId:'p',version:'1'},work={id:'session:s'} as WorkProjection;
const entry={id:'r',origin:'https://example.com',kind:'password',position:1,total:1,expiresAt:new Date(Date.now()+60000).toISOString()};
function setup(){mocks.owner.mockReset().mockResolvedValue({id:'s',executionTarget:{targetId:'t',targetGeneration:2}});mocks.call.mockReset().mockImplementation(async({request})=>({request:request.workInput.action==='claim'?entry:null}));}
it('cancels a claimed input on FD disconnection using its captured Work and owner',async()=>{
 setup();const claims=new WorkInputClaims(),abort=new AbortController();await claims.run(input,work,{action:'claim',holder:'w',requestId:'r'},abort.signal);abort.abort();await vi.waitFor(()=>expect(mocks.call).toHaveBeenCalledTimes(2));expect(mocks.call.mock.calls[1]![0]).toMatchObject({profileId:'p',requireTargetGeneration:true,request:{method:'secure.input',sessionId:'s',targetId:'t',targetGeneration:2,workInput:{action:'cancel',holder:'w',requestId:'r'}}});
});
it('does not cancel a consumed request when the descriptor later closes',async()=>{
 setup();const claims=new WorkInputClaims(),abort=new AbortController();await claims.run(input,work,{action:'claim',holder:'w',requestId:'r'},abort.signal);const command={action:'deliver' as const,holder:'w',requestId:'r',value:'canary'};await claims.run(input,work,command,abort.signal);expect(command.value).toBe('');abort.abort();expect(mocks.call).toHaveBeenCalledTimes(2);
});
it('clears values even when trust or owner resolution fails',async()=>{
 setup();mocks.owner.mockRejectedValue(new Error('Untrusted'));const command={action:'deliver' as const,holder:'w',requestId:'r',value:'canary'};await expect(workInput(input,work,command,new AbortController().signal)).rejects.toThrow('Untrusted');expect(command.value).toBe('');expect(mocks.call).not.toHaveBeenCalled();
});
