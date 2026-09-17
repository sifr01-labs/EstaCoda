import {test,expect} from '@playwright/test';
test('one assistant identity per user turn, readable browser history and actionable partial results',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/canonical-activity.tsx';
 const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{CanonicalActivity}=await import(cp);
 const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<main id="test"></main>';const row=(id:string,kind:string,extra:any)=>({id,kind,sequence:1,timestamp:1,...extra});
 const items=[row('q','message',{role:'user',text:'Open the portal'}),row('a','message',{role:'assistant',text:'Opening the portal.'}),row('s','tool',{name:'browser.navigate',state:'running',summary:'Tool started'}),row('e','tool',{name:'browser.navigate',state:'completed',summary:'Tool completed'}),row('b','message',{role:'assistant',text:'The portal is ready.'}),row('q2','message',{role:'user',text:'Sign in'}),row('c','message',{role:'assistant',text:'I need your details.'}),row('r','result',{status:'partial'})];
 (window as any).browserOpened=0;createRoot(document.getElementById('test')!).render(React.createElement(CanonicalActivity,{items,results:()=>{},browser:()=>{(window as any).browserOpened++;}}));
 });
 await expect(page.locator('.ec-agent .ec-msghead:not(.ec-sr-only)')).toHaveCount(2);await expect(page.getByText('The portal is ready.')).toBeVisible();
 await page.locator('.ec-run-summary').click();await expect(page.locator('.ec-run-actiontitle').filter({hasText:'Open page'})).toHaveCount(2);await expect(page.getByText('Result not recorded',{exact:true})).toBeVisible();await expect(page.getByText('Running',{exact:true})).toHaveCount(0);await expect(page.getByText('browser.navigate',{exact:true}).first()).not.toBeVisible();
 await page.getByRole('button',{name:'Open browser',exact:true}).click();expect(await page.evaluate(()=>(window as any).browserOpened)).toBe(1);await page.screenshot({path:test.info().outputPath('browser-conversation.png')});
});
test('pending input exposes only a native-window action and drops stale requests after disconnect',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/work-input-prompt.tsx';
 const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{WorkInputPrompt}=await import(cp);const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<main id="test"></main>';
 const entry={id:'request',kind:'password',origin:'https://example.com',position:1,total:1,expiresAt:new Date(Date.now()+60000).toISOString()};
 const state={calls:[] as any[],listener:(_s:any)=>{},defer:false,resolve:()=>{},polled:false};(window as any).protected=state;
 const api={onSnapshot:(listener:any)=>{state.listener=listener;return()=>{};},workInput:{pending:async()=>{if(state.defer){state.polled=true;return new Promise(resolve=>{state.resolve=()=>resolve(entry);});}return entry;},open:async(...args:any[])=>{state.calls.push(args);}}};
 createRoot(document.getElementById('test')!).render(React.createElement(WorkInputPrompt,{api,work:{id:'session:s',profileId:'p'},browser:()=>{}}));
 });
 await expect(page.getByText('https://example.com',{exact:true})).toBeVisible();await expect(page.getByRole('textbox')).toHaveCount(0);await page.getByRole('button',{name:'Enter securely',exact:true}).click();expect(await page.evaluate(()=>(window as any).protected.calls)).toEqual([['session:s','request']]);
 await page.evaluate(()=>(window as any).protected.defer=true);await expect.poll(()=>page.evaluate(()=>(window as any).protected.polled)).toBe(true);
 await page.evaluate(()=>{const s=(window as any).protected;s.listener({status:'disconnected',profile:{id:'p'}});s.resolve();});await expect(page.getByRole('button',{name:'Enter securely',exact:true})).toHaveCount(0);
 await page.waitForTimeout(1200);await expect(page.getByText('https://example.com',{exact:true})).toHaveCount(0);
});
