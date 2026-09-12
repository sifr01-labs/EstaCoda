import {it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {createMockBrowserBackend} from './browser-backend.js';
import {HumanBrowserControl} from './human-control.js';
import {BrowserControlOwner} from './control-lease.js';
import {validateHumanBrowserCommand,validateHumanBrowserInput} from '../contracts/desktop-control/browser-human.js';
it('controls an existing browser with current sanitized frames and no raw renderer commands',async()=>{
 const png=await sharp({create:{width:100,height:80,channels:3,background:'#147dab'}}).png().toBuffer();
 const identity={documentEpoch:1,actionRevision:1,observationId:1};let url='https://93.184.216.34/';
 const backend={...createMockBrowserBackend(),kind:'local-cdp' as const,snapshot:vi.fn(async()=>({sessionId:'b',identity,url,observedAt:'2026-09-12',tab:{ref:'t',url,controlled:true}})),
 preflightAction:vi.fn(async()=>({action:'press' as const,sessionId:'b',identity,url,observedAt:'2026-09-12',tabRef:'t',target:{ref:'@e1',kind:'button' as const,formAssociated:false,submit:false}})),click:vi.fn(async()=>({sessionId:'b',identity,url,observedAt:'2026-09-12'})),press:vi.fn(async()=>({sessionId:'b',identity,url,observedAt:'2026-09-12'})),
 screenshot:vi.fn(async()=>({mimeType:'image/png' as const,base64:png.toString('base64'),observation:{screenshotId:'shot',sessionId:'b',tabRef:'t',identity,captureScope:'viewport' as const,sanitized:true as const,maskedRegionCount:0,viewport:{cssWidth:100,cssHeight:80,pixelWidth:100,pixelHeight:80}}}))};
 const owner=new BrowserControlOwner(),validate=vi.fn(async()=>{}),control=new HumanBrowserControl(backend,owner,validate),base={holder:'window',browserId:'b'};
 const acquired=await control.execute({...base,action:'acquire'}),lease=acquired.lease!;
 expect(backend.snapshot).not.toHaveBeenCalled();const view=await control.execute({...base,lease,action:'observe',sequence:1});expect(view.frame!.image.length).toBeLessThanOrEqual(60000);
 const clicked=await control.execute({...base,lease,action:'input',sequence:2,input:{kind:'pointer',frameId:view.frame!.frameId,x:.5,y:.5}});expect(backend.preflightAction).toHaveBeenCalledWith('click',expect.objectContaining({visualTarget:{screenshotId:'shot',x:50,y:40}}));expect(backend.click).toHaveBeenCalledWith(expect.objectContaining({ref:'@e1'}));
 await control.execute({...base,lease,action:'input',sequence:3,input:{kind:'key',frameId:clicked.frame!.frameId,key:'ب'}});expect(backend.press).toHaveBeenCalledWith(expect.objectContaining({key:'ب',text:'ب'}));
 await expect(control.execute({...base,lease,action:'input',sequence:3,input:{kind:'key',frameId:view.frame!.frameId,key:'Enter'}})).rejects.toThrow('replayed');expect(backend.press).toHaveBeenCalledTimes(1);
 url='http://169.254.169.254/';await expect(control.execute({...base,lease,action:'observe',sequence:4})).rejects.toThrow('blocked');await expect(owner.agent(async()=>1)).rejects.toThrow('paused');
 // Explicit recovery can acquire and return control without dispatching or replaying input.
 const recovery=await control.execute({...base,action:'acquire'});await control.execute({...base,lease:recovery.lease!,action:'release'});expect(await owner.agent(async()=>1)).toBe(1);
 validate.mockRejectedValue(new Error('Trust revoked'));await expect(control.execute({...base,action:'acquire'})).rejects.toThrow('Trust revoked');
});
it('rejects modifiers, script, arbitrary URLs and malformed or unbounded input',()=>{
 for(const value of [{kind:'pointer',frameId:'f',x:NaN,y:0},{kind:'pointer',frameId:'f',x:1,y:0},{kind:'key',frameId:'f',key:'Enter',ctrl:true},{kind:'key',frameId:'f',key:'a'.repeat(100)},{kind:'key',frameId:'f',key:'\n'}])expect(()=>validateHumanBrowserInput(value)).toThrow();
 expect(()=>validateHumanBrowserCommand({action:'acquire',holder:'w',browserId:'b',url:'http://localhost',cdp:'Runtime.evaluate'})).toThrow();
 expect(()=>validateHumanBrowserCommand({action:'input',holder:'w',browserId:'b',lease:{id:'l',generation:1},sequence:1,input:{kind:'key',frameId:'f',key:'ب'}})).not.toThrow();
});
it('routes workspace operations through the held lease and keeps creation IDs runtime owned',async()=>{
 const workspace=vi.fn(async()=>({supported:true,reason:null,truncated:false,sessions:[{id:'existing',tabs:[]}]}));
 const backend={...createMockBrowserBackend(),kind:'local-cdp' as const,workspace,preflightAction:vi.fn(),click:vi.fn(),press:vi.fn()};
 const owner=new BrowserControlOwner(),control=new HumanBrowserControl(backend,owner,async()=>{}),base={holder:'desktop',browserId:'existing'};
 expect((await control.execute({...base,action:'inventory'})).workspace!.sessions).toHaveLength(1);
 expect(await owner.agent(async()=>true)).toBe(true);
 const lease=(await control.execute({...base,action:'acquire'})).lease!;
 const result=await control.execute({...base,lease,sequence:1,action:'workspace',operation:{kind:'create',url:'https://93.184.216.34/'}});
 expect(result.workspace!.selectedSessionId).not.toBe(base.browserId);
 expect(workspace).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:result.workspace!.selectedSessionId,action:{kind:'create',url:'https://93.184.216.34/'}}));
 await expect(control.execute({...base,lease,sequence:2,action:'workspace',operation:{kind:'list'}})).rejects.toThrow('owner changed');
 const next={...base,browserId:result.workspace!.selectedSessionId!};
 await expect(control.execute({...next,lease,sequence:2,action:'workspace',operation:{kind:'select-session',sessionId:'other-profile'}})).rejects.toThrow('not owned');
 await expect(owner.agent(async()=>true)).rejects.toThrow('paused');
});
it('declares unsupported backends without creating sessions or spending cloud credit',async()=>{
 const backend={...createMockBrowserBackend(),kind:'browserbase' as const,navigate:vi.fn()},control=new HumanBrowserControl(backend,new BrowserControlOwner(),async()=>{});
 const result=await control.execute({browserId:'b',holder:'desktop',action:'inventory'});
 expect(result.workspace).toMatchObject({supported:false,sessions:[]});expect(backend.navigate).not.toHaveBeenCalled();
 await expect(control.execute({browserId:'b',holder:'desktop',action:'acquire'})).rejects.toThrow('supervised local');
});
it.each(['submit','cancel','stale','expired'])('protects sign-in values and cleans up the %s outcome',async outcome=>{
 const {createSupervisedLocalCdpBrowserBackend}=await import('./supervised-local-cdp-backend.js');
 const {createFakeCdpAuthPortalSocketFactory,createFakeCdpFetch,showCredentialLoginPage}=await import('../test/fakes/fake-cdp-auth-portal.js');
 const harness=createFakeCdpAuthPortalSocketFactory(),backend=createSupervisedLocalCdpBrowserBackend({cdpUrl:'http://127.0.0.1:9222',fetch:createFakeCdpFetch(),webSocketFactory:harness.webSocketFactory,resolveHostname:()=>['93.184.216.34']});
 try{
  await backend.navigate({sessionId:'b',url:'https://93.184.216.34/'});
  const socket=harness.pageSocket()!;showCredentialLoginPage(socket);socket.snapshot.url='https://93.184.216.34/login';socket.browserActionPreflight={ref:'@e2',kind:'form-control',tag:'input',formAssociated:true,submit:false,protectedInput:true};
  let now=0;const owner=new BrowserControlOwner(()=>now),control=new HumanBrowserControl(backend,owner,async()=>{}),base={browserId:'b',holder:'main'},lease=(await control.execute({...base,action:'acquire'})).lease!;
  const frame=(await control.execute({...base,lease,sequence:1,action:'observe'})).frame!;
  expect(frame.protectedFieldFocused).toBe(true);expect(frame.submitTargets).toContainEqual({ref:'@e3',label:'Log in'});
  const prepared=await control.execute({...base,lease,sequence:2,action:'signin-prepare',frameId:frame.frameId,submitRef:'@e3',kind:'password'});
  expect(prepared.entry?.origin).toBe('https://93.184.216.34');expect(backend.isSensitiveInputActive!('b')).toBe(true);
  if(outcome==='cancel'){
   await control.execute({...base,lease,sequence:3,action:'signin-cancel'});expect(backend.isSensitiveInputActive!('b')).toBe(false);
   await control.execute({...base,lease,action:'release'});return;
  }
  if(outcome==='stale'||outcome==='expired'){
   if(outcome==='stale')socket.protectedFieldInspection.current=false;else now=20_000;
   const before=socket.sent.length;
   await expect(control.execute({...base,lease,sequence:3,action:'signin-deliver',entryId:prepared.entry!.id,value:'fixture-rejected-secret'})).rejects.toThrow();
   expect(JSON.stringify(socket.sent.slice(before))).not.toContain('fixture-rejected-secret');
   await expect(owner.agent(async()=>true)).rejects.toThrow('paused');return;
  }
  const request={...base,lease,sequence:3,action:'signin-deliver' as const,entryId:prepared.entry!.id,value:'fixture-password-unique'};
  const result=await control.execute(request);expect(request.value).toBe('');expect(JSON.stringify(result)).not.toContain('fixture-password');
  expect(backend.isSensitiveInputActive!('b')).toBe(false);
  const delivery=socket.sent.find(message=>message.method==='Runtime.callFunctionOn'&&JSON.stringify(message.params?.arguments??[]).includes('fixture-password-unique'))!;
  expect(delivery).toBeDefined();expect(String(delivery.params?.functionDeclaration)).not.toContain('fixture-password');
  await control.execute({...base,lease,action:'release'});
 }finally{await backend.close!();}
});
