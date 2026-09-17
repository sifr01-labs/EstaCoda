import {test,expect,type Page} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';
async function mount(page:Page,language:'en'|'ar'='en',inspectError=false,panels=false){
 await page.goto('/fixture.html');await page.evaluate(async ({language,inspectError,panels})=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',ap='/src/renderer/app.tsx',pp='/src/renderer/appearance.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{App}=await import(ap),{AppearanceProvider}=await import(pp);
  document.getElementById('root')!.remove();const host=document.createElement('div');document.body.append(host);
  const target={targetId:'target',targetGeneration:1,label:'Project',isolation:'host',approvalMode:'strict'};
  const work={id:'session:one',canonicalId:'private-work-uuid',profileId:'default',kind:'session',title:'Review the project',status:'completed',target,modelBinding:{sessionId:'one'},updatedAt:1,actions:[{id:'sessions.send',enabled:true},{id:'sessions.resume',enabled:true},{id:'sessions.cancelTurn',enabled:false}]};
  const listeners=new Set<any>();const state={work,inspectError,receipt:{state:'completed',cancellation:'not_requested'} as any,calls:[] as any[],copied:'',selection:null as any,inputRequest:null as any,inputPolls:0,primary:'First model',delay:false,release:()=>{},items:[] as any[],refresh:()=>listeners.forEach(fn=>fn(snapshot()))};
  const row=(id:string,kind:string,extra:any)=>({id,kind,workId:work.id,profileId:'default',timestamp:1,sequence:0,...extra});
  state.items=[row('user','message',{role:'user',text:'Review this code'}),row('start','tool',{name:'file.read',callId:'call-read',state:'running',summary:'Tool started'}),row('end','tool',{name:'file.read',callId:'call-read',state:'completed',summary:'Tool completed'}),row('result','result',{status:'completed',evidence:{state:'unverified',summary:'Canonical execution outcome. Inspect evidence before relying on external effects.',artifactIds:[]},usage:{reportedTokens:null,cost:null}}),row('answer','message',{role:'assistant',text:'## Review\n\nReadable **response** with `inline code`.\n\n- First finding\n- Second finding\n\n| File | Result |\n| --- | --- |\n| app.ts | Good |\n\n```ts\nconst result = 1;\n```\n\n[Reference](https://example.com/docs)\n\n![tracking](https://tracking.invalid/pixel.png)\n\n<script>window.injected=true</script>\n\n[unsafe](javascript:alert(1))'})];
  const snapshot=()=>({status:'ready',profile:{id:'default',label:'default',configuration:'ready'},runtime:'ready',work:{items:[{...work}],nextCursor:null},inbox:{items:[],nextCursor:null}});
  let route:any;
  const models={models:async()=>({items:[{id:'first',providerId:'local',label:state.primary,role:'primary',runnable:true,catalog:{configured:true}},{id:'second',providerId:'local',label:'Second model',role:'fallback',runnable:true,catalog:{configured:true}},{id:'catalog',providerId:'other',label:'Catalog only',role:null,runnable:true,catalog:{configured:false}}],nextCursor:null}),workOverride:async()=>({selection:state.selection,effective:'next_turn'}),inspectOverride:async()=>null,setOverride:async(id:string,value:any)=>{state.calls.push(['override',id,value]);state.selection=value;return{state:'completed'};},providers:async()=>({items:[{id:'local',label:'Local',state:'ready',authMethods:['none'],metadata:{configurable:true,defaultEndpoint:'http://localhost:11434/v1'}}],nextCursor:null}),begin:async(value:any)=>{route=value;state.calls.push(['begin']);return{setupId:'setup'};},cancel:async()=>{state.calls.push(['cancel']);return{cancelled:true};},review:async()=>({draftId:'setup',role:'primary',route,expiresInMs:300000,credentialState:'not_required'}),apply:async()=>{state.calls.push(['apply']);state.primary='New model';return{operationId:'setup',state:'applied',verification:'configured'};}};
  const api={platform:'darwin',models,workInput:{pending:async()=>{state.inputPolls++;return state.inputRequest;},open:async(...args:any[])=>{state.calls.push(['secure',...args]);}},onSnapshot:(fn:any)=>{listeners.add(fn);fn(snapshot());return()=>listeners.delete(fn);},getWork:async()=>({...work}),activity:async()=>({items:[...state.items],nextCursor:null}),microphone:{begin:async()=>{state.calls.push(['microphone']);return{id:'capture'};},cancel:async()=>({cancelled:true})},work:{pins:async()=>[],targets:async()=>({items:[target],truncated:false}),children:async()=>({items:[],nextCursor:null}),live:async()=>({active:false}),inspect:async()=>{if(state.inspectError)throw Error('Unavailable');return state.receipt;},act:async(value:any)=>{state.calls.push(['act',value]);return state.receipt;},usage:async()=>({scope:'session',reportedTokens:null,providerCalls:0,usageComplete:false,pricingComplete:false,cost:null,context:null}),submit:async(value:any)=>{state.calls.push(['submit',value]);if(state.delay)await new Promise<void>(resolve=>state.release=resolve);throw Error('Response lost');}}};
  if(panels)Object.assign(api,{files:{list:async()=>({items:[{name:'src',path:'src',kind:'directory'},{name:'README.md',path:'README.md',kind:'file'}],truncated:false}),preview:async()=>({path:'README.md',size:38,binary:false,text:'# Project documentation\nRead-only preview.',truncated:false})},browser:{list:async()=>({items:[],truncated:false})},terminal:{open:async()=>{state.calls.push(['terminal-open']);return{id:'terminal',backend:'host'};},read:async()=>({data:'',state:'running',truncated:false,more:false}),resize:async()=>{},write:async()=>{},close:async()=>{state.calls.push(['terminal-close']);}}});
  (window as any).presentation=state;(window as any).desktop=api;Object.defineProperty(navigator,'clipboard',{value:{writeText:async(value:string)=>{state.copied=value;}}});
  const appearance={read:async()=>({theme:'kemet',appearance:'light',language,density:'comfortable'}),write:async()=>{}};
  createRoot(host).render(React.createElement(AppearanceProvider,{store:appearance},React.createElement(App,{adapter:{kind:'live',api,appearance}})));
 },{language,inspectError,panels});await page.locator('.ec-taskbutton').filter({hasText:'Review the project'}).click();await expect(page.locator('.ec-workheading')).toContainText('Review the project');
}
test('conversation renders Markdown, groups tools, and moves routine diagnostics to Details',async({page},testInfo)=>{
 const external:string[]=[];page.on('request',r=>{if(r.url().includes('tracking.invalid'))external.push(r.url());});await mount(page);
 await expect(page.getByRole('heading',{name:'Review',exact:true})).toBeVisible();await expect(page.locator('.ec-markdown strong')).toHaveText('response');await expect(page.locator('.ec-markdown table')).toBeVisible();await expect(page.locator('.ec-run-history')).toHaveCount(1);await expect(page.getByText('Tool started',{exact:true})).not.toBeVisible();
 await page.locator('.ec-run-summary').click();await expect(page.locator('.ec-run-action')).toHaveCount(1);await expect(page.locator('.ec-run-actiontitle')).toContainText('Read file');await page.locator('.ec-run-action>summary').click();await expect(page.getByText('Started',{exact:true})).toBeVisible();await expect(page.getByText('Running',{exact:true})).toHaveCount(0);await expect(page.getByText('Tool completed',{exact:true})).toBeVisible();await expect(page.getByText('Canonical execution outcome.',{exact:false})).toHaveCount(0);await expect(page.getByText('Reported tokens:',{exact:false})).toHaveCount(0);await expect(page.getByText('private-work-uuid',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Stop',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Copy code',exact:true}).click();expect(await page.evaluate(()=>(window as any).presentation.copied)).toBe('const result = 1;\n');expect(await page.evaluate(()=>(window as any).injected)).toBeUndefined();expect(external).toEqual([]);await expect(page.locator('.ec-markdown img,.ec-markdown script,.ec-markdown a[href^="javascript:"]')).toHaveCount(0);
 await page.getByRole('button',{name:'Show inspector',exact:true}).click();const inspector=page.getByRole('complementary',{name:'Work details'});await inspector.getByRole('tab',{name:'Activity',exact:true}).click();await inspector.getByText('Technical details',{exact:true}).click();await inspector.getByText('Work ID',{exact:true}).click();await expect(inspector).toContainText('private-work-uuid');await expect(inspector.getByRole('button',{name:'Check execution status',exact:true})).toBeVisible();await inspector.getByRole('button',{name:'Copy ID',exact:true}).click();await inspector.getByRole('tab',{name:'Overview',exact:true}).click();await expect(inspector.getByText('Local Mac',{exact:true})).toBeVisible();await expect(inspector.getByText('Connected',{exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).presentation.copied)).toBe('private-work-uuid');
 await page.getByRole('button',{name:'Hide inspector',exact:true}).click();await page.setViewportSize({width:1440,height:960});await page.screenshot({path:testInfo.outputPath('work.png')});
});
test('Enter sends once; Shift+Enter and composing text do not send',async({page})=>{
 await mount(page);const input=page.getByLabel('Draft guidance');await input.fill('First line');await input.press('Shift+Enter');await input.press('a');await expect(input).toHaveValue('First line\na');
 await input.evaluate(el=>{el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,repeat:true}));});expect(await page.evaluate(()=>(window as any).presentation.calls.filter((c:any)=>c[0]==='submit').length)).toBe(0);
 await page.evaluate(()=>(window as any).presentation.delay=true);await input.press('Enter');await input.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));expect(await page.evaluate(()=>(window as any).presentation.calls.filter((c:any)=>c[0]==='submit').length)).toBe(1);await page.evaluate(()=>(window as any).presentation.release());await expect(input).toHaveValue('First line\na');await expect(input).toBeDisabled();await expect(page.getByRole('button',{name:'Check status',exact:true})).toBeVisible();
 await expect(input).toHaveCSS('outline-style','none');
});
test('resolved model, configured choices, and provider setup preserve the draft',async({page})=>{
 await mount(page);await page.getByLabel('Draft guidance').fill('Keep this draft');const picker=page.getByRole('button',{name:'Work model',exact:true});await expect(picker).toContainText('First model');await picker.click();await expect(page.getByRole('button',{name:/Catalog only/})).toHaveCount(0);
 await page.getByRole('button',{name:'Second model local',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();await expect(picker).toContainText('Second model');await picker.click();await page.getByRole('button',{name:/Use profile default/}).click();await page.getByRole('button',{name:'Add a new provider…',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByLabel('Draft guidance')).toHaveValue('Keep this draft');await expect(picker).toBeFocused();
 await picker.click();await page.getByRole('button',{name:'Add a new provider…',exact:true}).click();await page.getByLabel('Model ID',{exact:true}).fill('new-model');await page.getByRole('button',{name:'Continue without a credential',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();await expect(picker).toContainText('New model');await expect(page.getByLabel('Draft guidance')).toHaveValue('Keep this draft');
});
test('new activity follows the bottom without pulling readers away from older messages',async({page})=>{
 await mount(page);await page.evaluate(()=>{const s=(window as any).presentation;s.items=Array.from({length:50},(_,i)=>({id:'m'+i,kind:'message',role:'assistant',text:'Paragraph '+i,timestamp:i,sequence:i}));s.refresh();});const panel=page.locator('#ec-work-panel');await expect(page.getByText('Paragraph 49',{exact:true})).toBeVisible();await expect.poll(()=>panel.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)).toBeLessThan(48);
 await panel.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});await page.evaluate(()=>{const s=(window as any).presentation;s.items.push({id:'new',kind:'message',role:'assistant',text:'New paragraph',timestamp:51,sequence:51});s.refresh();});await expect(page.getByText('New paragraph',{exact:true})).toBeAttached();await expect.poll(()=>panel.evaluate(e=>e.scrollTop)).toBe(0);
});

for(const language of ['en','ar'] as const)test(`${language} composer menus float without taking space from Work`,async({page},testInfo)=>{
 await mount(page,language);const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 for(const width of [360,1280]){
  await page.setViewportSize({width,height:900});const composer=page.locator('.ec-composer');await composer.scrollIntoViewIfNeeded();const before=(await composer.boundingBox())!.height;
  await page.getByRole('button',{name:t('Work model'),exact:true}).click();const menu=page.getByRole('group',{name:t('Model for this Work'),exact:true});await expect(menu).toBeInViewport();expect((await composer.boundingBox())!.height).toBe(before);expect(await menu.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await page.screenshot({path:testInfo.outputPath(`models-${language}-${width}.png`)});await page.keyboard.press('Escape');
  await page.getByRole('button',{name:t('Voice input'),exact:true}).click();const voice=page.getByRole('group',{name:t('Voice input'),exact:true});await expect(voice).toBeInViewport();expect((await composer.boundingBox())!.height).toBe(before);await expect(page.getByRole('button',{name:t('Record audio'),exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).presentation.calls.some((c:any)=>c[0]==='microphone'))).toBe(false);await voice.getByRole('button',{name:t('Close'),exact:true}).click();
 }
});


test('compact header and composer reserve the window for the conversation',async({page},testInfo)=>{
 await mount(page);await page.setViewportSize({width:1280,height:900});
 const header=page.locator('.ec-conversation-header');const composer=page.locator('.ec-composer');
 await expect(header.getByRole('heading',{name:'Review the project'})).toBeVisible();
 await expect(header.locator('.ec-crumb')).toHaveCount(0);
 await expect(page.getByRole('tab',{name:'Conversation',exact:true})).toBeVisible();
 await expect(page.getByText('Enter to send · Shift+Enter for a new line',{exact:true})).toHaveCount(0);
 expect((await header.boundingBox())!.height).toBeLessThanOrEqual(56);
 expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(106);
 expect((await page.locator('#ec-work-panel').boundingBox())!.height).toBeGreaterThan(570);
 await expect(page.getByRole('button',{name:'Resume',exact:true})).not.toBeVisible();
 await page.locator('summary[aria-label="More actions"]').click();await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.locator('summary[aria-label="More actions"]')).toBeFocused();await expect(page.getByRole('button',{name:'Resume',exact:true})).not.toBeVisible();
 await page.getByLabel('Draft guidance').fill(Array.from({length:12},()=> 'Draft line').join('\n'));expect((await page.getByLabel('Draft guidance').boundingBox())!.height).toBeLessThanOrEqual(140);
 await page.getByLabel('Draft guidance').fill('');
 await page.screenshot({path:testInfo.outputPath('compact-conversation.png')});
});

test('operation problems remain discoverable without expanding the header; active stop stays visible',async({page})=>{
 await mount(page,'en',true);const height=(await page.locator('.ec-conversation-header').boundingBox())!.height;
 await expect(page.locator('summary[aria-label="Status unavailable"]')).toBeVisible();
 await expect(page.getByText('Operation status unavailable. Check again after reconnecting.',{exact:true})).not.toBeVisible();
 expect((await page.locator('.ec-conversation-header').boundingBox())!.height).toBe(height);
 await page.locator('summary[aria-label="Status unavailable"]').click();await expect(page.getByRole('alert')).toContainText('Operation status unavailable');
 await page.evaluate(()=>{const s=(window as any).presentation;s.inspectError=false;s.receipt={state:'uncertain',cancellation:'not_requested'};});
 await page.locator('.ec-operation-warning').getByRole('button',{name:'Check execution status',exact:true}).click();await expect(page.locator('summary[aria-label="Needs attention"]')).toBeVisible();
 await page.evaluate(()=>{const s=(window as any).presentation;s.work.status='running';s.work.actions=[{id:'sessions.cancelTurn',enabled:true}];s.refresh();});
 await expect(page.getByRole('button',{name:'Stop',exact:true})).toBeVisible();await page.getByRole('button',{name:'Stop',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).presentation.calls.filter((c:any)=>c[0]==='act'))).toHaveLength(1);
});

for(const language of ['en','ar'] as const)test(`${language} compact layout keeps composer and recovery visible in a short narrow window`,async({page},testInfo)=>{
 await mount(page,language);const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 for(const width of [360,1024]){
  await page.setViewportSize({width,height:740});
  await expect(page.getByLabel(t('Draft guidance'))).toBeInViewport();
  const composer=(await page.locator('.ec-composer').boundingBox())!;const footer=(await page.locator('.ec-runtimebar').boundingBox())!;
  expect(composer.y+composer.height).toBeLessThanOrEqual(footer.y);expect(footer.y-composer.y-composer.height).toBeLessThanOrEqual(15);
  expect(await page.locator('.ec-window').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  await page.locator('summary[aria-label="'+t('More actions')+'"]').click();await expect(page.getByRole('button',{name:t('Resume'),exact:true})).toBeInViewport();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:t('Show inspector'),exact:true}).click();await expect(page.getByRole('complementary',{name:t('Work details')})).toBeInViewport();await page.getByRole('button',{name:t('Hide inspector'),exact:true}).click();
  await page.screenshot({path:testInfo.outputPath(`compact-${language}-${width}.png`)});
 }
});


test('narrow running Tasks keep both pause and cancel accessible',async({page})=>{
 await mount(page);await page.setViewportSize({width:360,height:740});
 await page.evaluate(()=>{const s=(window as any).presentation;s.work.kind='task';s.work.status='running';s.work.title='A long task title that should truncate without hiding execution controls';s.work.actions=[{id:'tasks.pause',enabled:true},{id:'tasks.cancel',enabled:true}];s.refresh();});
 await expect(page.getByRole('button',{name:'Pause Task',exact:true})).toBeInViewport();
 await expect(page.getByRole('button',{name:'Cancel Task',exact:true})).toBeInViewport();
 expect(await page.locator('.ec-window').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
});

for(const language of ['en','ar'] as const)test(`${language} conversation navigator previews and jumps without crowding an expanded draft`,async({page},testInfo)=>{
 await mount(page,language);await page.setViewportSize({width:1280,height:900});const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 await page.evaluate(()=>{const s=(window as any).presentation;s.items=Array.from({length:80},(_,i)=>({id:'turn'+i,kind:'message',role:i%2===0?'user':'assistant',text:i%2===0?'Question '+i:'Response '+i+'\n\nA longer answer to keep the conversation scrollable.',timestamp:i,sequence:i}));s.refresh();});
 const panel=page.locator('#ec-work-panel'),rail=page.getByRole('navigation',{name:t('Loaded conversation turns')});await expect(rail).toBeVisible();
 await expect.poll(()=>rail.getByRole('button').count()).toBeLessThan(40);await expect.poll(()=>panel.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)).toBeLessThan(48);
 const first=rail.getByRole('button').first();await page.keyboard.press('Tab');await first.focus();await expect(first.locator('.ec-turn-preview')).toBeVisible();await page.keyboard.press('Enter');await expect.poll(()=>panel.evaluate(e=>Math.abs(e.querySelector('[data-conversation-turn]')!.getBoundingClientRect().top-e.getBoundingClientRect().top-12))).toBeLessThan(2);
 await expect(page.getByRole('button',{name:t('Back to latest')})).toBeVisible();await first.press('ArrowDown');await expect(rail.getByRole('button').nth(1)).toBeFocused();
 await page.getByLabel(t('Draft guidance')).fill(Array.from({length:12},()=> 'Draft line').join('\n'));
 const back=page.getByRole('button',{name:t('Back to latest')});await expect.poll(async()=>{const b=(await back.boundingBox())!,c=(await page.locator('.ec-composer').boundingBox())!;return b.y+b.height<=c.y;}).toBe(true);
 const bubble=page.locator('.ec-usernote').first();expect((await bubble.boundingBox())!.width).toBeLessThan((await panel.boundingBox())!.width/2);
 await back.click();await expect.poll(()=>panel.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)).toBeLessThan(48);await expect(back).toHaveCount(0);
 await page.getByLabel(t('Draft guidance')).fill('');await page.getByRole('button',{name:t('Show inspector'),exact:true}).click();
 await page.screenshot({path:testInfo.outputPath(`refined-${language}.png`)});
 await page.setViewportSize({width:360,height:740});expect(await page.locator('.ec-window').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
});

test('workspace grouping stays stable when chats settle and empty titles read New chat',async({page})=>{
 await mount(page);const group=page.locator('.ec-recents > .ec-workspacegroup');await expect(group).toHaveCount(1);await expect(group.locator('summary')).toContainText('Project');await expect(group.locator('.ec-taskbutton')).toContainText('Review the project');await expect(group.locator('.ec-taskbutton small')).toHaveCount(0);
 await page.evaluate(()=>{const s=(window as any).presentation;s.work.status='running';s.refresh();});await expect(group).toHaveCount(1);await expect(page.locator('.ec-taskbutton')).toContainText('Review the project');
 await page.evaluate(()=>{const s=(window as any).presentation;s.work.title='Untitled session';s.work.status='draft';s.refresh();});await expect(page.locator('.ec-taskbutton')).toContainText('New chat');await expect(page.locator('.ec-workheading')).toContainText('New chat');
});

test('Details formats usage concisely while keeping exact estimates and context accessible',async({page},testInfo)=>{
 await mount(page);await page.evaluate(()=>{(window as any).desktop.work.usage=async()=>({scope:'session',reportedTokens:16645,providerCalls:2,usageComplete:true,pricingComplete:false,cost:{amount:0.0542,currency:'USD'},context:{usedTokens:8202,totalTokens:1048576,provider:'kimi',model:'kimi-k3'}});});
 await page.getByRole('button',{name:'Show inspector',exact:true}).click();const usage=page.getByRole('region',{name:'Canonical Work usage'});
 await expect(usage.getByText('16,645',{exact:true})).toBeVisible();await expect(usage.getByText('8.2K / 1.05M',{exact:true})).toBeVisible();await expect(usage.getByText(/<1%.* used/)).toBeVisible();
 await expect(usage.locator('.ec-cost-exact summary')).toContainText('$0.054');await expect(usage.locator('.ec-cost-exact summary')).toContainText('Partial');
 await usage.locator('.ec-cost-exact summary').click();await expect(usage.getByText('0.0542 USD',{exact:true})).toBeVisible();
 await usage.getByText('Measurement details',{exact:true}).click();await expect(usage.getByText('8,202 / 1,048,576',{exact:true})).toBeVisible();await expect(usage.getByText('kimi / kimi-k3',{exact:true})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('usage-details.png')});
});

for(const language of ['en','ar'] as const)test(`${language} secure input stays visible with long history and no page scrollbar`,async({page},testInfo)=>{
 await mount(page,language);const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 await page.evaluate(()=>{const s=(window as any).presentation;s.items=Array.from({length:80},(_,i)=>({id:'m'+i,kind:'message',role:i%2?'assistant':'user',text:'History paragraph '+i,timestamp:i,sequence:i}));s.inputRequest={id:'input',kind:'password',origin:'https://example.com',position:1,total:2,expiresAt:new Date(Date.now()+120000).toISOString()};s.refresh();});
 const prompt=page.getByRole('region',{name:t('Secure input required')});const panel=page.locator('#ec-work-panel');
 await expect(prompt).toBeVisible();await expect(panel.locator('.ec-inputrequest')).toHaveCount(0);
 for(const width of [360,1280]){
  await page.setViewportSize({width,height:740});await panel.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
  await expect(prompt).toBeInViewport();await expect(prompt.getByRole('button',{name:t('Enter securely'),exact:true})).toBeInViewport();await expect(page.getByLabel(t('Draft guidance'))).toBeInViewport();
  const viewport=await page.evaluate(()=>({overflow:getComputedStyle(document.documentElement).overflowY,extra:document.documentElement.scrollHeight-innerHeight}));expect(viewport.overflow).toBe('hidden');expect(viewport.extra).toBeLessThanOrEqual(1);
  await panel.hover();expect(await panel.evaluate(e=>getComputedStyle(e,'::-webkit-scrollbar-track').backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await panel.focus();await page.keyboard.press('PageDown');await expect.poll(()=>panel.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({path:testInfo.outputPath(`secure-dock-${language}-${width}.png`)});
 }
 await page.getByRole('tab',{name:t('Results'),exact:true}).click();await expect(prompt).toBeInViewport();await prompt.getByRole('button',{name:t('Enter securely'),exact:true}).click();expect(await page.evaluate(()=>(window as any).presentation.calls.at(-1))).toEqual(['secure','session:one','input']);
});
test('unbound historical chats do not poll target-bound secure input',async({page})=>{
 await mount(page);await page.evaluate(()=>{const s=(window as any).presentation;s.work.target=undefined;s.refresh();});await expect(page.locator('.ec-targetchip')).toHaveText('No workspace attached');
 const polls=await page.evaluate(()=>(window as any).presentation.inputPolls);await page.waitForTimeout(1200);expect(await page.evaluate(()=>(window as any).presentation.inputPolls)).toBe(polls);
});

for(const language of ['en','ar'] as const)test('workspace tools dock, resize, and retain an explicitly opened terminal '+language,async({page},testInfo)=>{
 await mount(page,language,false,true);const t=(key:Parameters<typeof translate>[1])=>translate(language,key);await page.setViewportSize({width:1600,height:1000});
 await page.getByRole('button',{name:t('Files'),exact:true}).click();const panel=page.getByRole('complementary',{name:t('Workspace files')});await expect(panel).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
 const conversation=await page.locator('.ec-workcenter').boundingBox(),bounds=await panel.boundingBox();expect(bounds!.width).toBeGreaterThan(300);expect(conversation!.width).toBeGreaterThan(400);
 await panel.getByRole('button',{name:'README.md',exact:true}).click();await expect(panel.getByText('# Project documentation',{exact:false})).toBeVisible();await page.screenshot({path:testInfo.outputPath('files-docked-'+language+'.png')});
 const width=await panel.boundingBox();await panel.getByRole('separator').focus();await page.keyboard.press(language==='ar'?'ArrowRight':'ArrowLeft');expect((await panel.boundingBox())!.width).toBeGreaterThan(width!.width);
 await panel.getByRole('button',{name:t('Expand panel')}).click();expect((await panel.boundingBox())!.width).toBeGreaterThan(1000);await panel.getByRole('button',{name:t('Restore panel size')}).click();
 await page.getByRole('button',{name:t('Terminal'),exact:true}).click();await expect(page.locator('.ec-terminal')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).presentation.calls.filter((c:any)=>c[0]==='terminal-open'))).toHaveLength(0);await page.getByRole('button',{name:t('Open terminal'),exact:true}).click();await expect(page.locator('.xterm')).toBeVisible();
 await page.getByRole('button',{name:t('Files'),exact:true}).click();await expect(page.locator('.xterm')).toBeHidden();expect(await page.evaluate(()=>(window as any).presentation.calls.filter((c:any)=>c[0]==='terminal-close'))).toHaveLength(0);
 await page.getByRole('button',{name:t('Terminal'),exact:true}).click();await expect(page.locator('.xterm')).toBeVisible();expect(await page.evaluate(()=>(window as any).presentation.calls.filter((c:any)=>c[0]==='terminal-open'))).toHaveLength(1);await page.getByRole('button',{name:t('Close terminal'),exact:true}).click();await expect(page.locator('.xterm')).toHaveCount(0);
 await page.getByRole('button',{name:t('Files'),exact:true}).click();await page.setViewportSize({width:360,height:740});await expect(panel).toBeInViewport();expect(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await page.screenshot({path:testInfo.outputPath('files-narrow-'+language+'.png')});await page.getByRole('button',{name:t('Close files'),exact:true}).click();await expect(page.getByLabel(t('Draft guidance'))).toBeInViewport();
});
