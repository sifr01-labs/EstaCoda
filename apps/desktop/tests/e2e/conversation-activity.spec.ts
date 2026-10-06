import {test,expect,type Page} from '@playwright/test';
async function mount(page:Page,language:'en'|'ar'='en',appearance:'light'|'dark'='light'){
 await page.goto('/fixture.html');await page.evaluate(async({language,appearance})=>{
 const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
 const {CanonicalActivity}=await import('/src/renderer/components/canonical-activity.tsx'),{LanguageContext}=await import('/src/renderer/i18n.tsx');
 const branded=document.querySelector('#ec-branded-workspace') as HTMLElement;branded.style.colorScheme=appearance;branded.dir=language==='ar'?'rtl':'ltr';
 const host=branded.querySelector('.ec-window') as HTMLElement;host.innerHTML='<main id="conversation-test" style="width:100%;max-width:800px;margin:0 auto;padding:32px 20px;overflow:auto"></main>';host.style.cssText='display:block;height:auto;min-height:900px';host.dataset.native='true';
 const base={workId:'session:s',profileId:'p',sequence:0,timestamp:1726408800000};let seq=0;const row=(kind:string,extra:any)=>({...base,id:'i'+seq++,timestamp:base.timestamp+seq*1000,kind,...extra});
 const tool=(callId:string,state:string)=>row('tool',{name:'browser.download',callId,state,summary:state==='running'?'Tool started':state==='failed'?'Tool failed':'Tool completed'});
 const items=[row('message',{role:'user',text:'Collect the API specifications and save them here.'}),row('message',{role:'assistant',phase:'progress',text:'I found the product pages.'}),row('plan',{steps:[{id:'one',title:'Collect specifications',status:'running'}]}),tool('first','running'),tool('first','failed'),tool('retry','running'),tool('retry','completed'),row('artifact',{label:'payments-v1.yaml',mimeType:'text/yaml',bytes:128,reference:{source:'session',ownerId:'s',artifactId:'file'}}),row('plan',{steps:[{id:'one',title:'Collect specifications',status:'completed'}]}),row('result',{status:'completed',recoveredErrors:true,evidence:{state:'verified',summary:'',artifactIds:[]},usage:{reportedTokens:null,cost:null}}),row('message',{role:'assistant',phase:'response',text:'## Your specification is ready.\n\nThe saved file is ready to review.'})];
 const state={items,status:'completed',more:false,listener:(_x:any)=>{},opens:0,results:0,delay:false,resolve:(_x:any)=>{},rerender:()=>{}};
 const api={onSnapshot:(fn:any)=>{state.listener=fn;return()=>{};},artifacts:{open:async()=>{state.opens++;if(state.delay)return new Promise(resolve=>state.resolve=resolve);return {artifact:{displayName:'payments-v1.yaml',mimeType:'text/yaml',reference:{source:'session',ownerId:'s',artifactId:'file'}},integrity:'verified',text:'openapi: 3.0.0',truncated:false};}}};
 const app=createRoot(document.getElementById('conversation-test')!);state.rerender=()=>app.render(React.createElement(LanguageContext.Provider,{value:language},React.createElement(CanonicalActivity,{items:[...state.items],workStatus:state.status,more:state.more,api,results:()=>state.results++})));
 (window as any).activityDesign=state;state.rerender();
 },{language,appearance});
}
test('keeps a durable run history with paired calls, earlier plans, failed attempts and outputs',async({page})=>{
 await mount(page);await expect(page.getByRole('heading',{name:'Your specification is ready.'})).toBeVisible();await expect(page.locator('.ec-run-history')).toHaveCount(1);await expect(page.locator('.ec-run-summary')).toContainText(/2\u2069 tool calls/);await expect(page.locator('.ec-run-summary')).toContainText('Recovered errors recorded');await expect(page.locator('.ec-run-history')).not.toHaveAttribute('open','');
 await page.locator('.ec-run-summary').click();await expect(page.locator('.ec-run-action')).toHaveCount(2);await page.locator('.ec-run-action>summary').first().click();await expect(page.locator('.ec-run-action').first()).toContainText('Tool failed');await page.locator('.ec-run-earlierplans>summary').click();await expect(page.locator('.ec-run-plan')).toHaveCount(2);
 await page.evaluate(()=>{const s=(window as any).activityDesign;s.rerender()});await expect(page.locator('.ec-run-history')).toHaveAttribute('open','');await expect(page.locator('.ec-run-action').first()).toHaveAttribute('open','');
 expect(await page.evaluate(()=>(window as any).activityDesign.opens)).toBe(0);await page.getByRole('button',{name:'Open payments-v1.yaml',exact:true}).click();await expect(page.locator('.ec-run-preview')).toContainText('openapi: 3.0.0');await page.getByRole('button',{name:'Close',exact:true}).click();await expect(page.getByRole('button',{name:'Open payments-v1.yaml',exact:true})).toBeFocused();await page.getByRole('button',{name:'View in Results',exact:true}).click();expect(await page.evaluate(()=>(window as any).activityDesign.results)).toBe(1);
});
test('keeps inspection open on completion and never labels partial history as currently working',async({page})=>{
 await mount(page);await page.evaluate(()=>{const s=(window as any).activityDesign;s.items=s.items.slice(0,4);s.status='running';s.rerender()});await expect(page.locator('.ec-run-summary strong')).toHaveText('Download file');await expect(page.locator('.ec-run-currentprose')).toContainText('I found the product pages.');await page.locator('.ec-run-summary').click();
 await page.evaluate(()=>{const s=(window as any).activityDesign;s.items.push({...s.items[3],id:'completion',state:'completed'});s.status='completed';s.rerender()});await expect(page.locator('.ec-run-history')).toHaveAttribute('open','');await expect(page.locator('.ec-run-action')).toHaveCount(1);
 await page.evaluate(()=>{const s=(window as any).activityDesign;s.status='running';s.more=true;s.rerender()});await expect(page.locator('.ec-run-summary strong')).toHaveText('Activity');await expect(page.locator('.ec-run-historylabel')).toContainText('More activity is available');
});
test('drops a pending preview when profile scope disconnects',async({page})=>{
 await mount(page);await page.evaluate(()=>(window as any).activityDesign.delay=true);await page.getByRole('button',{name:'Open payments-v1.yaml',exact:true}).click();await page.evaluate(()=>{const s=(window as any).activityDesign;s.listener({status:'ready',profile:{id:'other'}});s.resolve({artifact:{displayName:'STALE FILE'},integrity:'verified',text:'STALE CONTENT',truncated:false})});await expect(page.getByText('STALE CONTENT')).toHaveCount(0);await expect(page.getByRole('button',{name:'Open payments-v1.yaml',exact:true})).toBeDisabled();
});
for(const language of ['en','ar'] as const)for(const appearance of ['light','dark'] as const)test(`${language} ${appearance} conversation layout preserves readable history at narrow and desktop widths`,async({page},info)=>{
 await mount(page,language,appearance);for(const width of [360,1024]){await page.setViewportSize({width,height:1100});await expect(page.locator('.ec-run-summary')).toBeVisible();expect(await page.locator('#conversation-test').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath(`${language}-${appearance}-${width}.png`)});}
 await page.locator('.ec-run-summary').click();await page.locator('.ec-run-action>summary').first().click();await page.setViewportSize({width:360,height:1100});expect(await page.locator('#conversation-test').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath(`${language}-${appearance}-expanded.png`)});
});

test('response actions reveal only for their own response or keyboard focus without moving content',async({page})=>{
 await mount(page);await page.evaluate(()=>{const s=(window as any).activityDesign;s.items.push({...s.items.at(-1),id:'second-response',text:'A separate response.'});s.rerender();});
 const answers=page.locator('.ec-run-answer'),first=answers.first().locator('.ec-message-actions'),second=answers.last().locator('.ec-message-actions');
 await page.mouse.move(0,0);await expect(first).toHaveCSS('opacity','0');await expect(second).toHaveCSS('opacity','0');const before=await answers.last().boundingBox();
 await answers.first().hover();await expect(first).toHaveCSS('opacity','1');await expect(second).toHaveCSS('opacity','0');
 await page.mouse.move(0,0);await expect(first).toHaveCSS('opacity','0');await second.getByRole('button',{name:'Copy message'}).focus();await expect(second).toHaveCSS('opacity','1');await expect(first).toHaveCSS('opacity','0');
 expect(await answers.last().boundingBox()).toEqual(before);
});

test.describe('touch response actions',()=>{
 test.use({hasTouch:true});
 test('remain available without hover',async({page})=>{
  await mount(page);await expect(page.locator('.ec-run-answer .ec-message-actions')).toHaveCSS('opacity','1');
 });
});

for(const language of ['en','ar'] as const)test(`routing ${language} fallback remains visible and separate from the conversation model`,async({page})=>{
 await mount(page,language);await page.evaluate(()=>{const s=(window as any).activityDesign;const base=s.items[1];s.items.splice(1,0,{...base,id:'jev-fallback',kind:'routing',routing:{stage:'intent-skills',configuredMode:'jev-assisted',actualEngine:'standard',fallbackReason:'timeout'}},{...base,id:'jev-capabilities',kind:'routing',routing:{stage:'capabilities',configuredMode:'jev-assisted',actualEngine:'jev',model:'jev-1.13.0'}});s.rerender();});
 const notice=page.locator('.ec-agent>.ec-activitynotice');await expect(notice).toContainText(language==='ar'?'انتهت مهلة TypeSafe':'TypeSafe timed out');await expect(notice).not.toContainText('fallback model');
 await page.locator('.ec-run-summary').click();await expect(page.locator('.ec-run-historybody')).toContainText('jev-1.13.0');await expect(page.locator('.ec-run-historybody')).toContainText(language==='ar'?'النوايا والمهارات':'intents and skills');
 await page.setViewportSize({width:360,height:1050});expect(await page.locator('#conversation-test').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
});

test('Details keeps actual routing decisions separate from model settings',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
 const {Inspector}=await import('/src/renderer/components/inspector.tsx');
 const host=document.querySelector('.ec-window')!;host.innerHTML='<div id="routing-details"></div>';
 createRoot(document.getElementById('routing-details')!).render(React.createElement(Inspector,{fixture:false,routing:[{id:'r',kind:'routing',workId:'session:s',profileId:'p',sequence:1,timestamp:1,routing:{stage:'discovery',configuredMode:'jev-assisted',actualEngine:'standard',fallbackReason:'timeout'}}]}));
 });
 await page.getByRole('tab',{name:'Activity',exact:true}).click();await expect(page.getByRole('region',{name:'Intent & capability routing'})).toContainText('Routing · capability discovery: Standard');await expect(page.getByRole('region',{name:'Intent & capability routing'})).toContainText('TypeSafe timed out.');
});
