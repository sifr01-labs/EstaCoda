/** Real Chromium, loopback-only fixture; no provider, user browser profile or external account. */
import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';
import {createSupervisedLocalCdpBrowserBackend} from '../../../src/browser/supervised-local-cdp-backend.js';
import {HumanBrowserControl} from '../../../src/browser/human-control.js';
import {BrowserControlOwner} from '../../../src/browser/control-lease.js';
let submissions=0;
const server=createServer(async(req,res)=>{
 if(req.url==='/done'){
  let body='';for await(const chunk of req)body+=chunk;
  if(new URLSearchParams(body).get('password')!=='synthetic-browser-canary'){res.writeHead(400).end();return;}
  body='';submissions++;res.setHeader('Content-Type','text/html');res.end('<title>Signed in</title><h1>Signed in</h1>');return;
 }
 res.setHeader('Content-Type','text/html');res.end('<title>Local sign-in fixture</title><style>body{font:20px sans-serif;padding:36px}input,button{font:inherit;padding:12px;display:block;margin:12px}</style><form method="post" action="/done"><label>Password<input type="password" name="password" autocomplete="current-password" autofocus></label><button type="submit">Sign in</button></form>');
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/';
const backend=createSupervisedLocalCdpBrowserBackend({autoLaunch:true,headless:true,chromeFlags:['--headless=new'],launchExecutable:chromium.executablePath(),securityConfig:{allowPrivateUrls:true}});
const owner=new BrowserControlOwner(),control=new HumanBrowserControl(backend,owner,async()=>{},{allowPrivateUrls:true});
let browserId='new',sequence=0;const holder='native-test',lease=(await control.execute({action:'acquire',browserId,holder})).lease!;
const renew=setInterval(()=>{try{owner.renew(holder,lease);}catch{}},2000);
const action=async(operation:import('../../../src/contracts/desktop-control/browser-human.js').BrowserWorkspaceAction)=>{
 const result=await control.execute({action:'workspace',operation,browserId,holder,lease,sequence:++sequence});browserId=result.workspace!.selectedSessionId!;return result.workspace!;
};
try{
 await action({kind:'create',url});const frame=(await control.execute({action:'observe',browserId,holder,lease,sequence:++sequence})).frame!;
 expect(frame.url).toBe(url);expect(frame.protectedFieldFocused).toBe(true);
 const submit=frame.submitTargets!.find(target=>target.label==='Sign in')!;expect(submit).toBeDefined();
 const prepared=await control.execute({action:'signin-prepare',browserId,holder,lease,sequence:++sequence,frameId:frame.frameId,submitRef:submit.ref,kind:'password'});
 const result=await control.execute({action:'signin-deliver',browserId,holder,lease,sequence:++sequence,entryId:prepared.entry!.id,value:'synthetic-browser-canary'});
 expect(JSON.stringify(result)).not.toContain('synthetic-browser-canary');expect(submissions).toBe(1);
 const signedIn=(await control.execute({action:'observe',browserId,holder,lease,sequence:++sequence})).frame!;expect(signedIn.title).toBe('Signed in');
 const tabs=await action({kind:'new-tab',url});expect(tabs.sessions[0]!.tabs).toHaveLength(2);
 await action({kind:'close-tab',tabRef:tabs.sessions[0]!.tabs.find(tab=>tab.closable)!.ref});
 await action({kind:'navigate',url});await action({kind:'reload'});await action({kind:'back'});await action({kind:'forward'});
 const closed=await action({kind:'close-session'});expect(closed.sessions).toEqual([]);
 await control.execute({action:'release',browserId,holder,lease});expect(await owner.agent(async()=>true)).toBe(true);
 console.log('Real Chromium workspace: create, protected sign-in, capture, tabs, history, reload, cleanup and explicit return passed.');
}catch(error){console.error(error);throw error;}finally{clearInterval(renew);await backend.close!();await new Promise<void>(resolve=>server.close(()=>resolve()));}
