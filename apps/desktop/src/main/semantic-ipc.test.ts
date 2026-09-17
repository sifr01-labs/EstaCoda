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
it('accepts only target-scoped read inputs, never renderer filesystem authority',()=>{
 const payload={target:{targetId:'target',targetGeneration:1},path:'src/app.ts'};
 for(const method of ['filesList','filesPreview']){
  expect(()=>validateSemanticPayload(method,payload)).not.toThrow();
  for(const extra of [{profileId:'other'},{root:'/private'},{command:'cat'},{write:true}])expect(()=>validateSemanticPayload(method,{...payload,...extra})).toThrow();
 }
});
it('keeps Git command and configuration selection out of Changes IPC',()=>{
 const target={targetId:'t',targetGeneration:1};
 expect(()=>validateSemanticPayload('diffPatch',{target,path:'src/app.ts',stage:'staged'})).not.toThrow();
 for(const extra of [{args:['--ext-diff']},{gitDir:'/other'},{profileId:'other'}])expect(()=>validateSemanticPayload('diffList',{target,...extra})).toThrow();
 expect(()=>validateSemanticPayload('diffPatch',{target,path:'file',stage:'HEAD~1'})).toThrow();
});
it('exposes terminal handles without accepting capability, process or approval authority',()=>{
 expect(()=>validateSemanticPayload('terminalOpen',{target:{targetId:'t',targetGeneration:1}})).not.toThrow();
 expect(()=>validateSemanticPayload('terminalWrite',{id:'terminal',data:'ls\r'})).not.toThrow();
 for(const extra of [{capabilityId:'core'},{cwd:'/other'},{env:{TOKEN:'secret'}},{human:true},{approvalId:'pending'},{pid:123}])expect(()=>validateSemanticPayload('terminalWrite',{id:'terminal',data:'x',...extra})).toThrow();
 expect(()=>validateSemanticPayload('terminalWrite',{id:'terminal',data:'x'.repeat(4097)})).toThrow();
 expect(()=>validateSemanticPayload('terminalResize',{id:'terminal',cols:500,rows:24})).toThrow();
 expect(()=>validateSemanticPayload('terminalVerify',{id:'terminal'})).toThrow();
});
it('accepts browser inspection references and rejects renderer control or network authority',()=>{
 const reference={sessionId:'s',browserId:'b',eventId:1,target:{targetId:'t',targetGeneration:1}};
 expect(()=>validateSemanticPayload('browserList',{workId:'session:s'})).not.toThrow();
 expect(()=>validateSemanticPayload('browserSnapshot',{workId:'session:s',reference})).not.toThrow();
 for(const extra of [{url:'https://example.com'},{cdpUrl:'ws://secret'},{profileId:'other'},{human:true},{control:true}])expect(()=>validateSemanticPayload('browserSnapshot',{workId:'session:s',reference,...extra})).toThrow();
 for(const method of ['browserNavigate','browserClick','browserCDP','browserTakeover'])expect(()=>validateSemanticPayload(method,{workId:'session:s',reference})).toThrow();
});
it('accepts only bounded browser input behind a Main handle',()=>{
 const payload={id:'handle',input:{kind:'key',frameId:'frame',key:'ب'}};
 expect(()=>validateSemanticPayload('browserControlFrame',payload)).not.toThrow();
 for(const extra of [{lease:{id:'forged',generation:1}},{holder:'other'},{sequence:1},{profileId:'other'},{cdp:'Input.dispatchKeyEvent'}])expect(()=>validateSemanticPayload('browserControlFrame',{...payload,...extra})).toThrow();
 expect(()=>validateSemanticPayload('browserControlFrame',{id:'handle',input:{kind:'key',frameId:'frame',key:'Enter',ctrl:true}})).toThrow();
});

it('exposes semantic workspace and protected-entry metadata without accepting secrets or CDP',()=>{
 expect(()=>validateSemanticPayload('browserControlWorkspace',{id:'handle',operation:{kind:'navigate',url:'https://example.com'}})).not.toThrow();
 expect(()=>validateSemanticPayload('browserControlSignIn',{id:'handle',frameId:'frame',submitRef:'@e3',kind:'password'})).not.toThrow();
 for(const extra of [{value:'canary'},{entryId:'forged'},{lease:{id:'l',generation:1}},{profileId:'other'},{method:'Runtime.evaluate'}])expect(()=>validateSemanticPayload('browserControlSignIn',{id:'handle',frameId:'frame',submitRef:'@e3',kind:'password',...extra})).toThrow();
 for(const operation of [{kind:'navigate',url:'https://example.com',script:'alert(1)'},{kind:'cdp'},{kind:'signin-deliver',value:'canary'},{kind:'switch-tab',tabRef:'raw-cdp-target'}])expect(()=>validateSemanticPayload('browserControlWorkspace',{id:'handle',operation})).toThrow();
});

it('accepts only scoped observation references without control authority',()=>{
 expect(()=>validateSemanticPayload('browserControlWatch',{workId:'session:s',browserId:'b'})).not.toThrow();
 for(const extra of [{lease:{id:'l',generation:1}},{value:'secret'},{url:'https://example.com'},{profileId:'other'}])expect(()=>validateSemanticPayload('browserControlWatch',{workId:'session:s',browserId:'b',...extra})).toThrow();
});
it('keeps settings identity and credentials out of ordinary semantic requests',()=>{
 for(const method of ['settingsApply','settingsCancel','settingsStage','settingsReview'])for(const extra of [{profileId:'other'},{windowId:'other'},{generation:2},{credential:'raw'}])expect(()=>validateSemanticPayload(method,{setupId:'s',...extra})).toThrow();
 expect(()=>validateSemanticPayload('settingsRead',{section:'runtime',path:'/tmp/config.json'})).toThrow();expect(()=>validateSemanticPayload('settingsRead',{section:'runtime'})).not.toThrow();
 expect(()=>validateSemanticPayload('settingsReview',{setupId:'s',changes:[{fieldId:'ui.language',selectors:[],value:'ar'}]})).not.toThrow();
});

it('keeps onboarding detection and bootstrap bound to Main selected profile',()=>{for(const method of ['onboardingDetect','onboardingBootstrap']){expect(()=>validateSemanticPayload(method,{})).not.toThrow();for(const value of [{profileId:'other'},{path:'/tmp'},{confirmed:true}])expect(()=>validateSemanticPayload(method,value)).toThrow();}});
it('allows only native workspace selection and reviewed trust input',()=>{
 expect(()=>validateSemanticPayload('onboardingChooseWorkspace',{})).not.toThrow();
 expect(()=>validateSemanticPayload('onboardingReviewWorkspace',{alias:'work',trust:false})).not.toThrow();
 for(const payload of [{alias:'work',trust:true,path:'/escape'},{alias:'work',trust:'true'},{alias:'work',trust:true,profileId:'other'}])expect(()=>validateSemanticPayload('onboardingReviewWorkspace',payload)).toThrow();
});
it('requires explicit onboarding confirmation and rejects renderer credential or profile scopes',()=>{
 for(const method of ['onboardingApply','onboardingApplyWorkspace']){expect(()=>validateSemanticPayload(method,{reviewId:'r',confirmed:true})).not.toThrow();for(const payload of [{reviewId:'r',confirmed:false},{reviewId:'r'},{reviewId:'r',confirmed:true,profileId:'other'}])expect(()=>validateSemanticPayload(method,payload)).toThrow();}
 expect(()=>validateSemanticPayload('onboardingReview',{modelSetupId:'m',preferences:[],workspaceReviewId:'w',windowId:'other'})).toThrow();
 expect(()=>validateSemanticPayload('onboardingReview',{modelSetupId:'m',preferences:[],workspaceReviewId:'w'})).not.toThrow();
});
it('keeps Library scope and Evolution confirmations owned by Main',()=>{
 for(const method of ['librarySkills','libraryMemory','libraryProposals'])expect(()=>validateSemanticPayload(method,{profileId:'other'})).toThrow();
 expect(()=>validateSemanticPayload('evolutionReview',{proposalId:'p',action:'rollback'})).not.toThrow();
 for(const extra of [{operationId:'forged'},{profileId:'other'},{commands:['pnpm run test']},{target:{targetId:'t',targetGeneration:1}}])expect(()=>validateSemanticPayload('evolutionExecute',{reviewId:'r',confirmed:true,...extra})).toThrow();
 expect(()=>validateSemanticPayload('evolutionExecute',{reviewId:'r',confirmed:false})).toThrow();expect(()=>validateSemanticPayload('evolutionInspect',{operationId:'forged'})).toThrow();
});
it('allows only a Work and opaque request ID from the ordinary renderer for secure input',()=>{
 expect(()=>validateSemanticPayload('workInputPending',{workId:'session:s'})).not.toThrow();
 expect(()=>validateSemanticPayload('workInputOpen',{workId:'session:s',requestId:'r'})).not.toThrow();
 for(const extra of [{value:'canary'},{holder:'forged'},{origin:'https://evil.example'},{targetGeneration:2},{profileId:'other'},{command:{action:'deliver'}}])expect(()=>validateSemanticPayload('workInputOpen',{workId:'session:s',requestId:'r',...extra})).toThrow();
});
it('accepts only presentation state and canonical chat references for chat actions',()=>{
 expect(()=>validateSemanticPayload('chatRead',{profile:'default'})).not.toThrow();
 expect(()=>validateSemanticPayload('chatWrite',{profile:'default',value:{selected:'welcome',drafts:{},chats:{}}})).not.toThrow();
 expect(()=>validateSemanticPayload('chatOpenFolder',{workId:'session:one'})).not.toThrow();
 for(const payload of [{workId:'session:one',path:'/private'},{target:{targetId:'one',targetGeneration:1}},{workId:'../foreign'}])expect(()=>validateSemanticPayload('chatOpenFolder',payload)).toThrow();
 expect(()=>validateSemanticPayload('chatWrite',{profile:'default',value:{selected:'welcome',drafts:{x:{id:'x',text:'draft',model:'m',limitsReviewed:true}},chats:{}}})).toThrow();
});

it('permits bounded clipboard writes without granting reads or renderer authority',()=>{
 expect(()=>validateSemanticPayload('clipboardWrite',{text:'chat-id'})).not.toThrow();
 for(const payload of [{text:'x'.repeat(1_000_001)},{text:7},{text:'id',read:true},{text:'id',profileId:'other'}])expect(()=>validateSemanticPayload('clipboardWrite',payload)).toThrow();
});

it('accepts bounded connector controls without renderer authority or executable input',()=>{
 expect(()=>validateSemanticPayload('connectorsControl',{action:'inspect'})).not.toThrow();
 expect(()=>validateSemanticPayload('connectorsControl',{action:'reconnect',workId:'session:s'})).not.toThrow();
 for(const payload of [{action:'reconnect'},{action:'execute',workId:'session:s'},{action:'inspect',profileId:'other'},{action:'reconnect',workId:'session:s',command:'node'},{action:'inspect',targetId:'other'},{action:'inspect',credential:'secret'}])expect(()=>validateSemanticPayload('connectorsControl',payload)).toThrow();
});

it('bounds conversation permission and interruption controls without accepting forged authority',()=>{
 const input={draftId:'d',workId:'session:s',target:{targetId:'t',targetGeneration:1},text:'Continue',attachmentIds:[]};
 for(const securityMode of ['strict','adaptive','open'])expect(()=>validateSemanticPayload('workSubmit',{...input,securityMode,interrupt:true})).not.toThrow();
 for(const extra of [{securityMode:'yolo'},{interrupt:'true'},{inspectOnly:1},{securityMode:'open',kind:'task'},{profileId:'other',securityMode:'open'},{operationId:'forged'}])expect(()=>validateSemanticPayload('workSubmit',{...input,...extra})).toThrow();
});

it('accepts explicit provider-only review without allowing auxiliary or authority fields',()=>{
 expect(()=>validateSemanticPayload('setupReview',{setupId:'setup',role:{role:'provider'}})).not.toThrow();
 for(const role of [{role:'provider',slot:'assessor'},{role:'provider',fallbackToMain:true},{role:'provider',profileId:'other'}])expect(()=>validateSemanticPayload('setupReview',{setupId:'setup',role})).toThrow();
});

it('bounds dropped-file input and never accepts renderer-owned profile or raw picker paths',()=>{
 const scope={draftId:'draft',target:{targetId:'target',targetGeneration:1}};
 expect(()=>validateSemanticPayload('workAttachFiles',{...scope,paths:['/tmp/notes.md']})).not.toThrow();
 for(const paths of [[],Array(5).fill('/tmp/n'),['relative.md'],['/tmp/\0n'],['/'.repeat(4097)],[42]])expect(()=>validateSemanticPayload('workAttachFiles',{...scope,paths})).toThrow();
 for(const extra of [{profileId:'other'},{generation:4},{text:'injected'}])expect(()=>validateSemanticPayload('workAttachFiles',{...scope,paths:['/tmp/n'],...extra})).toThrow();
 expect(()=>validateSemanticPayload('workAttach',{...scope,paths:['/tmp/n']})).toThrow();
 expect(()=>validateSemanticPayload('workAttach',{...scope,workspace:true})).not.toThrow();
 expect(()=>validateSemanticPayload('workAttach',{...scope,workspace:'/tmp'})).toThrow();
});
