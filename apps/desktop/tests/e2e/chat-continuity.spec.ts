import {test,expect,type Page} from '@playwright/test';
async function mount(page:Page){
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',ap='/src/renderer/app.tsx',pp='/src/renderer/appearance.tsx';
 const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{App}=await import(ap),{AppearanceProvider}=await import(pp);
 document.getElementById('root')!.remove();const host=document.createElement('div');document.body.append(host);
 const target={targetId:'project',targetGeneration:1,label:'Project',isolation:'host',readiness:'ready'};
 const work={id:'session:one',canonicalId:'one',profileId:'default',kind:'session',title:'Existing chat',status:'completed',updatedAt:1,target,actions:[{id:'sessions.send',enabled:true}]};
 const state={reference:work,items:[work],lookups:0,submitted:[] as any[],opened:[] as any[],copied:'',saved:JSON.parse(sessionStorage.getItem('chats-test')??'null'),listeners:new Set<any>(),live:{active:false,text:'',turnId:null,truncated:false},activity:[] as any[]};
 const snapshot=()=>({status:'ready',profile:{id:'default',label:'default',configuration:'ready'},runtime:'ready',work:{items:state.items,nextCursor:null},inbox:{items:[],nextCursor:null},counts:{runningSessions:0,runningTasks:0,approvals:0,attention:0,scheduled:0}});
 const api:any={clipboard:{writeText:async(v:string)=>{state.copied=v;}},platform:'darwin',onSnapshot:(fn:any)=>{state.listeners.add(fn);queueMicrotask(()=>fn(snapshot()));return()=>state.listeners.delete(fn);},getWork:async(id:string)=>{if(id==='session:new'&&++state.lookups<3)throw Error('Not yet visible');return {...work,id,title:id==='session:new'?'First message':id==='session:older'?'Older chat':work.title};},activity:async()=>({items:state.activity,nextCursor:null}),chats:{read:async()=>state.saved??{selected:'welcome',drafts:{},chats:{}},write:async(_p:string,v:any)=>{state.saved=v;sessionStorage.setItem('chats-test',JSON.stringify(v));},openFolder:async(id:string)=>{state.opened.push(id);}},work:{targets:async()=>({items:[target],truncated:false}),pins:async()=>[],live:async()=>state.live,inspect:async()=>null,children:async()=>({items:[],nextCursor:null}),submit:async(v:any)=>{state.submitted.push(v);return{workId:'session:new',receipt:{method:'sessions.send',state:'accepted'}};}}};
 (state as any).refresh=()=>state.listeners.forEach(fn=>fn(snapshot()));(window as any).continuity=state;(window as any).desktop=api;Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('Browser clipboard denied');}}});
 const appearance={read:async()=>({theme:'kemet',appearance:'dark',density:'comfortable'}),write:async()=>{}};createRoot(host).render(React.createElement(AppearanceProvider,{store:appearance},React.createElement(App,{adapter:{kind:'live',api,appearance}})));
 });await expect(page.locator('.ec-taskbutton').first()).toBeVisible();
}
test('draft workspace, prompt and selected chat survive reopening; first send does not flash an error or send twice',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'New chat',exact:true}).click();await page.getByRole('button',{name:'Work target',exact:true}).click();await page.getByRole('button',{name:'Project',exact:false}).last().click();
 const box=page.locator('textarea');await box.fill('First message');await expect.poll(()=>page.evaluate(()=>(window as any).continuity.saved?.drafts[(window as any).continuity.saved.selected]?.text)).toBe('First message');
 await mount(page);await expect(box).toHaveValue('First message');await expect(page.getByRole('button',{name:'Work target'})).toContainText('Project');
 await page.evaluate(()=>{(window as any).errors=[];new MutationObserver(()=>{if(document.body.textContent?.includes('Chat could not be opened'))(window as any).errors.push('error');}).observe(document.body,{subtree:true,childList:true});});await box.press('Enter');await expect(page.locator('.ec-workheading')).toContainText('First message');
 expect(await page.evaluate(()=>(window as any).continuity.submitted)).toHaveLength(1);expect(await page.evaluate(()=>(window as any).errors)).toEqual([]);
 await expect.poll(()=>page.evaluate(()=>(window as any).continuity.saved.selected)).toBe('session:new');expect(await page.evaluate(()=>Object.keys((window as any).continuity.saved.drafts).filter(id=>id.startsWith('draft-')))).toEqual([]);
});
test('chat actions support keyboard rename, unread, copy, workspace opening and reversible archive',async({page},info)=>{
 await mount(page);let row=page.locator('.ec-taskbutton').filter({hasText:'Existing chat'});await row.click({button:'right'});await page.getByRole('menuitem',{name:'Rename chat'}).click();await page.getByLabel('Chat name',{exact:true}).fill('My project');await page.getByRole('button',{name:'Save name'}).click();
 row=page.locator('.ec-taskbutton').filter({hasText:'My project'});await row.focus();await row.press('Shift+F10');await expect(page.getByRole('menu')).toBeVisible();await page.getByRole('menuitem',{name:'Mark as unread'}).click();await expect(page.locator('.ec-unread')).toContainText('My project');
 await row.click({button:'right'});await page.getByRole('menuitem',{name:'Copy chat ID'}).click();expect(await page.evaluate(()=>(window as any).continuity.copied)).toBe('one');
 await page.evaluate(()=>{(window as any).continuity.activity=[{id:'user',kind:'message',role:'user',text:'Prompt'},{id:'agent',kind:'message',role:'agent',text:'Reply'}];});await row.click({button:'right'});await page.getByRole('menuitem',{name:'Copy conversation'}).click();expect(await page.evaluate(()=>(window as any).continuity.copied)).toBe('You:\nPrompt\n\nEstaCoda:\nReply');
 await row.click({button:'right'});await page.getByRole('menuitem',{name:'Open workspace folder'}).click();expect(await page.evaluate(()=>(window as any).continuity.opened)).toEqual(['session:one']);
 await row.click({button:'right'});await page.screenshot({path:info.outputPath('chat-menu.png')});await page.getByRole('menuitem',{name:'Archive chat'}).click();await expect(row).toHaveCount(0);await page.getByRole('button',{name:'Archived',exact:true}).click();await page.getByRole('button',{name:'Restore chat'}).click();await expect(row).toBeVisible();
 await mount(page);await expect(page.locator('.ec-taskbutton').filter({hasText:'My project'})).toBeVisible();
});
test('live text stays visible until canonical history arrives, then appears exactly once',async({page})=>{
 await mount(page);await page.evaluate(()=>{const s=(window as any).continuity;s.live={active:true,turnId:'turn',text:'A streamed response',truncated:false};s.items[0].status='running';});await page.locator('.ec-taskbutton').filter({hasText:'Existing chat'}).click();await expect(page.getByText('A streamed response',{exact:true})).toHaveCount(1);
 await page.evaluate(()=>(window as any).continuity.live={active:false,turnId:null,text:'',truncated:false});await page.waitForTimeout(400);await expect(page.getByText('A streamed response',{exact:true})).toHaveCount(1);
 await page.evaluate(()=>{const s=(window as any).continuity;s.activity=[{kind:'message',id:'final',workId:'session:one',profileId:'default',role:'assistant',text:'A streamed response',timestamp:2,sequence:2}];s.listeners.forEach((fn:any)=>fn({status:'ready',profile:{id:'default',label:'default',configuration:'ready'},runtime:'ready',work:{items:s.items.map((w:any)=>({...w,status:'completed'})),nextCursor:null},inbox:{items:[],nextCursor:null}}));});await expect(page.locator('.ec-live-response')).toHaveCount(0);await expect(page.getByText('A streamed response',{exact:true})).toHaveCount(1);
});
for(const language of ['en','ar'])test('credential stylesheet works under CSP in '+language,async({page},info)=>{
 await page.setViewportSize({width:520,height:410});await page.addInitScript(({language})=>{(window as any).credential={describe:async()=>({provider:'Portal',purpose:'provider',mode:'work',language,appearance:{theme:'kemet',appearance:'dark'},field:{label:language==='ar'?'كلمة المرور':'Password',origin:'https://example.com',position:2,total:2}}),submit:async()=>({accepted:true}),cancel:async()=>{}};},{language});await page.goto('/credential.html');
 await expect(page.locator('h1')).toHaveCSS('font-size','22px');await expect(page.locator('#secret')).toHaveCSS('border-radius','10px');await expect(page.locator('html')).toHaveAttribute('dir',language==='ar'?'rtl':'ltr');await expect(page.locator('#purpose')).toHaveText('https://example.com · 2 / 2');expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).not.toContain('unsafe-inline');await page.screenshot({path:info.outputPath('credential-'+language+'.png')});
});

test('an open chat outside the list refreshes its status after runtime updates',async({page})=>{
 await mount(page);await page.locator('.ec-taskbutton').filter({hasText:'Existing chat'}).click();
 await page.evaluate(()=>{const s=(window as any).continuity;s.items=[];s.refresh();});await expect(page.locator('.ec-workheading')).toContainText('Completed');
 await page.evaluate(()=>{const s=(window as any).continuity;s.reference.status='running';s.refresh();});await expect(page.locator('.ec-workheading')).toContainText('Running');
});

test('archived chats outside the recent list are retrievable and restorable',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(()=>sessionStorage.setItem('chats-test',JSON.stringify({selected:'welcome',drafts:{},chats:{'session:older':{archived:true}}})));
 await mount(page);await page.getByRole('button',{name:'Archived',exact:true}).click();await expect(page.getByRole('button',{name:'Older chat',exact:true})).toBeVisible();await page.getByRole('button',{name:'Restore chat'}).click();await expect(page.locator('.ec-taskbutton').filter({hasText:'Older chat'})).toBeVisible();
});

test('uncertain delivery keeps the draft and shows a compact warning without retrying',async({page},info)=>{
 await mount(page);await page.locator('.ec-taskbutton').filter({hasText:'Existing chat'}).click();
 await page.evaluate(()=>{const s=(window as any).continuity;(window as any).desktop.work.submit=async(v:any)=>{s.submitted.push(v);throw Error('Response lost');};});
 const box=page.locator('textarea');await box.fill('Keep this draft');await box.press('Enter');
 await expect(page.getByRole('alert')).toContainText('We couldn’t check whether your message was sent. Your draft is saved.');
 await expect(box).toHaveValue('Keep this draft');expect(await page.evaluate(()=>(window as any).continuity.submitted.length)).toBe(1);
 await page.screenshot({path:info.outputPath('delivery-warning.png')});
});
