import { expect,it,vi } from 'vitest';
vi.mock('electron',()=>({ipcMain:{}}));
import {validateSemanticPayload} from './semantic-ipc.js';
it('rejects renderer authority fields and invalid IDs',()=>{
 for(const payload of [{workId:'a',profileId:'other'},{workId:'../escape'},{workId:'a',generation:1},{workId:'a',cursor:'a'.repeat(2049)}])expect(()=>validateSemanticPayload('activity',payload)).toThrow();
 expect(()=>validateSemanticPayload('activity',{workId:'session:1'})).not.toThrow();
 expect(()=>validateSemanticPayload('snapshot',{method:'sessions.send'})).toThrow();
});

it('accepts only an ID for independent Work inspection',()=>{
 expect(()=>validateSemanticPayload('getWork',{workId:'session:old'})).not.toThrow();
 for(const payload of [{workId:'../escape'},{workId:'a',profileId:'other'},{workId:'a',cursor:'x'},{}])expect(()=>validateSemanticPayload('getWork',payload)).toThrow();
});

it('bounds catalog paging and forbids network or profile authority in ordinary payloads',()=>{
 expect(()=>validateSemanticPayload('modelPage',{cursor:'page_1'})).not.toThrow();
 for(const payload of [{cursor:'../bad'},{profileId:'other'},{limit:999},{credential:'secret'}])expect(()=>validateSemanticPayload('modelPage',payload)).toThrow();
 expect(()=>validateSemanticPayload('refreshCatalog',{})).not.toThrow();expect(()=>validateSemanticPayload('refreshCatalog',{url:'https://other'})).toThrow();
});
it('rejects credential values and caller-owned scope on every setup and override input',()=>{
 for(const method of ['setupStage','setupApply','setupCancel','setupVerify','setupOAuthStart','setupOAuthStatus'])for(const extra of [{credential:'canary'},{profileId:'other'},{windowId:'other'},{generation:100}])expect(()=>validateSemanticPayload(method,{setupId:'setup',...extra})).toThrow();
 for(const extra of [{profileId:'other'},{target:{targetId:'x',targetGeneration:1}},{sessionId:'other'},{operationId:'operation'}])expect(()=>validateSemanticPayload('setOverride',{workId:'session:s',selection:null,...extra})).toThrow();
 expect(()=>validateSemanticPayload('setupReview',{setupId:'s',role:{role:'primary',slot:'assessor'}})).toThrow();
 expect(()=>validateSemanticPayload('setupReview',{setupId:'s',role:{role:'auxiliary',slot:'vision',fallbackToMain:true}})).toThrow();
});
it('rejects Telegram credential/authority injection and requires operation confirmation',()=>{
 for(const method of ['telegramStage','telegramVerify','telegramApply','telegramCancel'])for(const extra of [{token:'secret'},{candidateId:'other'},{windowId:'forged'},{profileId:'other'},{generation:3}])expect(()=>validateSemanticPayload(method,{setupId:'setup',...extra})).toThrow();
 expect(()=>validateSemanticPayload('gatewayExecute',{action:'stop',acknowledgeSharedWork:false})).toThrow();expect(()=>validateSemanticPayload('telegramExecute',{action:'test',confirmed:true,destination:'123;command'})).toThrow();expect(()=>validateSemanticPayload('telegramHandoff',{workId:'session:s',action:'create',confirmed:true,sessionId:'other'})).toThrow();expect(()=>validateSemanticPayload('telegramExecute',{action:'test',confirmed:true,destination:'123'})).not.toThrow();
});
it('requires narrow target references and keeps paths, commands and operation IDs out of renderer mutations',()=>{
 const target={targetId:'t',targetGeneration:1};
 expect(()=>validateSemanticPayload('targetReview',{source:target})).not.toThrow();
 expect(()=>validateSemanticPayload('targetCreate',{reviewId:'r',trustNewPath:true})).not.toThrow();
 for(const extra of [{path:'/tmp/other'},{gitArgs:['--force']},{profileId:'other'},{operationId:'forged'},{generation:5}])expect(()=>validateSemanticPayload('targetExecute',{action:'archive',target,confirmed:true,...extra})).toThrow();
 expect(()=>validateSemanticPayload('targetCreate',{reviewId:'r',trustNewPath:false})).toThrow();
 expect(()=>validateSemanticPayload('targetExecute',{action:'cleanup',target,confirmed:false})).toThrow();
 expect(()=>validateSemanticPayload('targetInspect',{target:{...target,targetGeneration:0}})).toThrow();
});

it('accepts bounded target paging and direct lookup without accepting paths or caller scope',()=>{
 const cursor='target_00000000-0000-0000-0000-000000000001',target={targetId:cursor,targetGeneration:1};
 expect(()=>validateSemanticPayload('targetList',{cursor})).not.toThrow();
 expect(()=>validateSemanticPayload('workTargets',{target})).not.toThrow();
 for(const payload of [{cursor:'../escape'},{target,profileId:'other'},{path:'/tmp/source'},{target:{...target,targetGeneration:0}}])expect(()=>validateSemanticPayload('workTargets',payload)).toThrow();
});
