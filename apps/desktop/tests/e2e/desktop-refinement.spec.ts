import {test,expect,type Page} from '@playwright/test';
async function mount(page:Page,language='en'){
 await page.goto('/fixture.html');
 await page.evaluate(async language=>{
  const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js',appPath='/src/renderer/app.tsx',appearancePath='/src/renderer/appearance.tsx';
  const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default,{App}=await import(appPath),{AppearanceProvider}=await import(appearancePath);
  document.getElementById('root')!.remove();const root=document.createElement('div');document.body.append(root);
  const target={targetId:'t',targetGeneration:1,label:'Studio',isolation:'host',approvalMode:'adaptive'};
  const work={id:'session:demo',canonicalId:'demo',profileId:'p',kind:'session',title:'Refine the workspace',status:'running',target,modelBinding:{sessionId:'demo'},actions:[{id:'sessions.send',enabled:true},{id:'sessions.cancelTurn',enabled:true}],updatedAt:1};
  const state={calls:[] as any[],receipt:'dispatched',cancellation:'not_requested',method:'sessions.send',plan:null as any,uncertain:false,unacknowledged:false,work,refresh:()=>{},fields:[{id:'stt.enabled',path:['stt','enabled'],section:'voice',kind:'boolean'},{id:'stt.provider',path:['stt','provider'],section:'voice',kind:'choice',choices:['local','openai']},{id:'stt.openai.model',path:['stt','openai','model'],section:'voice',kind:'text'},{id:'tts.enabled',path:['tts','enabled'],section:'voice',kind:'boolean'},{id:'tts.provider',path:['tts','provider'],section:'voice',kind:'choice',choices:['edge','openai']}],changes:[] as any[]};
  const listeners=new Set<any>();const snapshot={status:'ready',profile:{id:'p',label:'Personal',configuration:'ready'},runtime:'ready',work:{items:[work],nextCursor:null},inbox:{items:[],nextCursor:null},counts:{runningSessions:1,runningTasks:0,approvals:0,scheduled:0}};
  state.refresh=()=>{for(const listener of listeners)listener({...snapshot,work:{items:[{...work}],nextCursor:null}});};
  const api={platform:'darwin',onSnapshot:(listener:any)=>{listeners.add(listener);listener(snapshot);return()=>listeners.delete(listener);},profiles:async()=>[{id:'p',label:'Personal'}],getWork:async()=>({...work}),activity:async()=>({items:[...(state.plan?[state.plan]:[]),{id:'u',kind:'message',role:'user',text:'Make the workspace feel calm and useful.',timestamp:1726408800000},{id:'a',kind:'message',role:'assistant',text:'I’ll refine the layout and preserve your execution controls.',timestamp:1726408801000}],nextCursor:null}),clipboard:{writeText:async(text:string)=>{state.calls.push(['copy',text]);}},
   work:{pins:async()=>[],targets:async()=>({items:[target],truncated:false}),live:async()=>({active:work.status==='running',turnId:'turn',text:'',truncated:false}),children:async()=>({items:[],nextCursor:null}),inspect:async()=>({method:state.method,state:state.receipt,cancellation:state.cancellation}),submit:async(input:any)=>{state.calls.push(['send',input]);if(state.uncertain)throw new Error('Response lost');return{workId:work.id,receipt:{method:'sessions.send',state:state.unacknowledged?'unknown':'accepted'}};},act:async(input:any)=>{state.calls.push(['act',input]);return{state:'completed',cancellation:'requested'};}},
   connections:{connectors:async(input:any)=>{state.calls.push(['connectors',input]);return{state:'ready',items:[{id:'Postman',state:'ready',toolCount:24}]};}},
   settings:{read:async(section:string)=>({fields:state.fields.filter(f=>f.section===section),values:[{fieldId:'stt.provider',selectors:[],value:'openai'},{fieldId:'tts.provider',selectors:[],value:'edge'}],truncated:false}),begin:async()=>({setupId:'draft'}),cancel:async()=>({cancelled:true}),review:async(_id:string,changes:any[])=>{state.calls.push(['review',changes]);state.changes=changes;return{draftId:'draft',changes,previous:[],expiresInMs:30000};},apply:async()=>{state.calls.push(['apply']);return{state:'applied'};},verify:async()=>({state:'configured'}),inspect:async()=>({state:'applied'}),dependencies:async()=>({items:[]})}
  };
  (window as any).refinement=state;(window as any).desktop=api;const appearance={read:async()=>({theme:'kemet',appearance:'light',density:'comfortable',language}),write:async()=>{}};
  createRoot(root).render(React.createElement(AppearanceProvider,{store:appearance},React.createElement(App,{adapter:{kind:'live',api,appearance}})));
 },language);
 if(!await page.locator('#ec-sidebar').isVisible())await page.locator('.ec-sidebar-toggle').click();
 await expect(page.locator('.ec-taskbutton').filter({hasText:'Refine the workspace'})).toBeVisible();
}
async function conversation(page:Page){await mount(page);await page.locator('.ec-taskbutton').filter({hasText:'Refine the workspace'}).click();await expect(page.getByLabel('Draft guidance')).toBeEditable();}
test('compact shell, breadcrumbs, sidebar toggle, and accessible message actions',async({page})=>{
 await conversation(page);await expect(page.getByText('0 need approval')).toHaveCount(0);await expect(page.getByText('0 scheduled')).toHaveCount(0);
 expect(await page.locator('.ec-runtimebar').evaluate(el=>el.getBoundingClientRect().height)).toBe(28);
 expect(await page.locator('.ec-main').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
 await page.getByRole('button',{name:'Copy message'}).first().focus();await expect(page.locator('.ec-message-actions').first()).toHaveCSS('opacity','1');await page.getByRole('button',{name:'Copy message'}).first().click();await expect(page.getByText('Copied',{exact:true})).toBeVisible();
 await page.screenshot({path:'/tmp/desktop-ux-conversation.png'});
 await page.getByRole('button',{name:'Hide sidebar',exact:true}).click();await expect(page.getByRole('complementary',{name:'Application navigation'})).toBeHidden();await page.getByRole('button',{name:'Show sidebar',exact:true}).click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Appearance Themes, color mode, and density'}).click();await page.getByRole('navigation',{name:'Page navigation'}).getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
});
test('queue is editable; Send now explicitly interrupts; permission selection requires Open review',async({page})=>{
 await conversation(page);await page.getByLabel('Change permissions').click();await page.getByRole('button',{name:'Open Fewer approval requests. Hard blocks remain.'}).click();expect(await page.evaluate(()=>(window as any).refinement.calls)).toEqual([]);await page.getByRole('button',{name:'Use Open',exact:true}).click();
 await page.getByLabel('Draft guidance').fill('Use the smaller toolbar');await page.getByLabel('Draft guidance').press('Enter');await expect(page.getByRole('region',{name:'Queued message'})).toBeVisible();expect(await page.evaluate(()=>(window as any).refinement.calls)).toEqual([]);
 await page.getByRole('button',{name:'Edit queued message'}).click();await expect(page.getByLabel('Draft guidance')).toHaveValue('Use the smaller toolbar');await page.getByLabel('Draft guidance').press('Enter');await page.getByRole('button',{name:'Send now',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).refinement.calls.filter((c:any)=>c[0]==='send').length)).toBe(1);expect(await page.evaluate(()=>(window as any).refinement.calls[0][1])).toMatchObject({interrupt:true,securityMode:'open',text:'Use the smaller toolbar'});await expect(page.getByRole('region',{name:'Queued message'})).toHaveCount(0);
});
test('lost acknowledgment preserves the queue and Check status is read-only',async({page})=>{
 await conversation(page);await page.getByLabel('Draft guidance').fill('Keep this correction');await page.getByLabel('Draft guidance').press('Enter');await page.evaluate(()=>(window as any).refinement.uncertain=true);await page.getByRole('button',{name:'Send now',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Your draft is saved');await page.getByRole('button',{name:'Check status',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).refinement.calls.at(-1)[1])).toMatchObject({inspectOnly:true});await expect(page.getByRole('region',{name:'Queued message'})).toContainText('Keep this correction');
});
test('Voice is a purpose-built form with review before apply',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Voice Independent speech-to-text and text-to-speech'}).click();await expect(page.getByRole('heading',{name:'Speech to text'})).toBeVisible();await expect(page.getByText('Public setting',{exact:true})).toHaveCount(0);
 await page.locator('#setting-stt\\.openai\\.model').fill('whisper-1');expect(await page.evaluate(()=>(window as any).refinement.calls)).toEqual([]);await page.screenshot({path:'/tmp/desktop-ux-voice.png'});await page.getByRole('button',{name:'Review changes',exact:true}).click();expect(await page.evaluate(()=>(window as any).refinement.calls.map((c:any)=>c[0]))).toEqual(['review']);await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByText('Settings saved. New executions use the reviewed configuration.',{exact:true})).toBeVisible();
});
for(const language of ['en','ar'])test(`narrow ${language} layout keeps content and controls in view`,async({page})=>{
 await page.setViewportSize({width:390,height:844});await mount(page,language);await page.locator('.ec-taskbutton').filter({hasText:'Refine the workspace'}).click();await expect(page.locator('#ec-sidebar')).toBeHidden();
 await expect(page.locator('#ec-guidance')).toBeEditable();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`/tmp/desktop-ux-${language}-narrow.png`});
 const box=await page.locator('#ec-guidance').boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(390);const dock=await page.locator('.ec-composerdock').boundingBox();expect(dock!.y+dock!.height).toBeGreaterThan(780);
});
test('a queued follow-up waits for acknowledgment and Stop preserves it',async({page})=>{
 await conversation(page);await page.getByLabel('Draft guidance').fill('Continue after this');await page.getByLabel('Draft guidance').press('Enter');await page.getByRole('button',{name:'Stop',exact:true}).click();await expect(page.getByText('Saved follow-up',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Stopping…',exact:true})).toBeDisabled();
 await page.evaluate(()=>{const state=(window as any).refinement;state.receipt='completed';state.work.status='cancelled';state.refresh();});await page.waitForTimeout(1200);expect(await page.evaluate(()=>(window as any).refinement.calls.filter((c:any)=>c[0]==='send'))).toEqual([]);
});

test('an uncertain first send stays with its draft until read-only reconciliation',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'New chat',exact:true}).click();await page.getByRole('button',{name:'Work target'}).click();await page.getByRole('button',{name:/Studio/}).click();
 await page.getByLabel('Draft guidance').fill('Start with a careful review');await page.evaluate(()=>(window as any).refinement.unacknowledged=true);await page.getByLabel('Draft guidance').press('Enter');
 await expect(page.getByRole('alert')).toContainText('Your draft is saved');await expect(page.getByLabel('Draft guidance')).toHaveValue('Start with a careful review');
 await page.evaluate(()=>(window as any).refinement.unacknowledged=false);await page.getByRole('button',{name:'Check status',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).refinement.calls.at(-1)[1])).toMatchObject({inspectOnly:true,text:'Start with a careful review'});
});

test('conversation permissions do not become background Task authority',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'New chat',exact:true}).click();await page.getByRole('button',{name:'Work target'}).click();await page.getByRole('button',{name:/Studio/}).click();
 await page.getByLabel('Change permissions').click();await page.getByRole('button',{name:'Open Fewer approval requests. Hard blocks remain.'}).click();await page.getByRole('button',{name:'Use Open',exact:true}).click();
 await page.getByText('Chat options',{exact:true}).click();await page.getByRole('checkbox',{name:'Run in background',exact:true}).check();await page.getByText('Review Task limits and authority',{exact:true}).click();await page.getByRole('checkbox',{name:'I reviewed the Task limits and authority.'}).check();
 await page.getByLabel('Draft guidance').fill('Review this workspace');await page.getByLabel('Draft guidance').press('Enter');await expect.poll(()=>page.evaluate(()=>(window as any).refinement.calls.filter((c:any)=>c[0]==='send').length)).toBe(1);
 const input=await page.evaluate(()=>(window as any).refinement.calls.find((c:any)=>c[0]==='send')[1]);expect(input.kind).toBe('task');expect(input).not.toHaveProperty('securityMode');expect(input).not.toHaveProperty('interrupt');
});

for(const language of ['en','ar'])test(`native drag areas stay clear of the sidebar toggle in ${language}`,async({page})=>{
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:844});await mount(page,language);await page.locator('.ec-taskbutton').filter({hasText:'Refine the workspace'}).click();
  const toggle=page.locator('.ec-sidebar-toggle');
  for(let cycle=0;cycle<2;cycle++){
   if(await toggle.getAttribute('aria-expanded')==='true')await toggle.click();
   await expect(toggle).toHaveAttribute('aria-expanded','false');
   // Browser clicks ignore Electron's native drag hit testing. Assert its
   // draggable header rectangle cannot cover the collapsed toggle as well.
   expect(await page.evaluate(()=>{
    const toggle=document.querySelector('.ec-sidebar-toggle')!.getBoundingClientRect();
    return [...document.querySelectorAll('.ec-topline')].every(header=>{
     const box=header.getBoundingClientRect();
     return getComputedStyle(header).getPropertyValue('-webkit-app-region')!=='drag'||box.left>=toggle.right||box.right<=toggle.left||box.top>=toggle.bottom||box.bottom<=toggle.top;
    });
   })).toBe(true);
   await toggle.click();await expect(page.locator('#ec-sidebar')).toBeVisible();await expect(toggle).toHaveAttribute('aria-expanded','true');
  }
 }
});

for(const language of ['en','ar'])test(`Details keeps a long recorded plan separate from overview and recovery ${language}`,async({page})=>{
 await page.setViewportSize({width:1280,height:800});await mount(page,language);
 await page.evaluate(()=>{const state=(window as any).refinement;state.work.status='partial';state.receipt='completed';state.plan={id:'plan',kind:'plan',steps:Array.from({length:18},(_,index)=>({id:String(index),title:'Step '+index+': Review the integration configuration and verify every recorded action before continuing. '.repeat(3),status:index===0?'completed':index===1?'running':'pending'}))};state.plan.steps[17].title+=' '+ 'x'.repeat(500);state.refresh();});
 await page.locator('.ec-taskbutton').filter({hasText:'Refine the workspace'}).click();await page.locator('[aria-controls="ec-details"]').click();
 const details=page.locator('#ec-details');await expect(details).toBeVisible();await expect(page.locator('#ec-details-overview')).toBeVisible();await expect(page.locator('#ec-details-plan')).toBeHidden();await expect(details.getByText('Postman',{exact:true})).toBeVisible();await expect(page.locator('.ec-chatconnectors')).toHaveCount(0);
 await page.screenshot({path:`/tmp/details-overview-${language}.png`});
 await page.locator('#ec-details-tab-plan').click();await expect(page.locator('.ec-plan-step')).toHaveCount(18);await expect(page.locator('.ec-plan-running')).toContainText(language==='ar'?'آخر حالة مسجلة: قيد التنفيذ':'Last recorded: in progress');await expect(page.locator('.ec-plan-running .lucide-loader-circle')).toHaveCount(0);
 await details.locator('.ec-details-scroll').evaluate(el=>el.scrollTop=el.scrollHeight);await details.locator('.ec-plan-step').last().locator('summary').click();expect(await details.locator('.ec-details-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await expect(page.locator('#ec-details-tab-activity')).toBeInViewport();await page.locator('#ec-details-tab-activity').click();await details.locator('.ec-technical-details>summary').click();await details.locator('summary').filter({hasText:language==='ar'?'معرّف':'Work ID'}).first().click();await expect(details.locator('.ec-identity')).toHaveText('demo');await expect(details.locator('#ec-operation-details')).not.toBeEmpty();
 await page.locator('#ec-details-tab-plan').click();await details.locator('.ec-details-scroll').evaluate(el=>el.scrollTop=0);await page.screenshot({path:`/tmp/details-plan-${language}.png`});
 const separator=details.getByRole('separator');await separator.focus();await separator.press('End');await expect(separator).toHaveAttribute('aria-valuenow','440');
 await page.setViewportSize({width:390,height:800});await expect(details).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`/tmp/details-narrow-${language}.png`});
 await details.getByRole('button').first().click();await expect(details).toHaveCount(0);await expect(page.locator('[aria-controls="ec-details"]')).toBeFocused();
});

for(const language of ['en','ar'])test(`sidebar rhythm and context menu affordances ${language}`,async({page})=>{
 await page.setViewportSize({width:1280,height:800});await mount(page,language);
 const sidebar=page.locator('#ec-sidebar');await expect(sidebar.locator('.ec-brand .ec-sidebar-toggle')).toBeVisible();await expect(page.locator('.ec-titlebar .ec-sidebar-toggle')).toHaveCount(0);
 const row=sidebar.locator('.ec-taskbutton').first();expect((await row.boundingBox())!.height).toBeLessThanOrEqual(44);
 await expect(sidebar.locator('.ec-profile')).toContainText(language==='ar'?'جهاز Mac هذا':'Local · This Mac');
 await row.click({button:'right'});const menu=page.getByRole('menu');await expect(menu).toBeVisible();
 const first=menu.getByRole('menuitem').first();await page.keyboard.press('Home');await expect(first).toHaveCSS('background-color','rgb(0, 127, 174)');
 expect(await menu.evaluate(el=>getComputedStyle(el).backdropFilter)).toContain('blur');
 await page.screenshot({path:`/tmp/polish-menu-${language}-light.png`});
 await page.locator('#ec-branded-workspace').evaluate(el=>el.setAttribute('data-appearance','dark'));await page.screenshot({path:`/tmp/polish-menu-${language}-dark.png`});
 await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await expect(row).toBeFocused();
});
test('Activity distinguishes a completed stop request from the work outcome',async({page})=>{
 await conversation(page);await page.evaluate(()=>{const s=(window as any).refinement;s.receipt='completed';s.cancellation='requested';s.method='sessions.cancelTurn';s.work.status='needs_attention';s.refresh();});
 await page.getByRole('button',{name:'Show inspector',exact:true}).click();await page.locator('#ec-details-tab-activity').click();const activity=page.locator('#ec-details-activity');await activity.getByRole('button',{name:'Check execution status',exact:true}).click();
 await expect(activity.locator('.ec-current-state')).toHaveText('Needs attention');await expect(activity).toContainText('Stop requested · awaiting confirmation');await expect(activity.getByText('Completed',{exact:true})).toHaveCount(0);await expect(activity.getByText('Stopping…',{exact:true})).toHaveCount(0);
 await page.screenshot({path:'/tmp/polish-activity.png'});
 await page.evaluate(()=>{const s=(window as any).refinement;s.work.status='cancelled';s.refresh();});await expect(activity.locator('.ec-current-state')).toHaveText('Cancelled');await expect(activity).toContainText('Request received · work has ended');
 await page.evaluate(()=>{(window as any).refinement.cancellation='confirmed';});await activity.getByRole('button',{name:'Check execution status',exact:true}).click();await expect(activity).toContainText('Stop confirmed');
 await page.evaluate(()=>{const s=(window as any).refinement;s.receipt='uncertain';s.cancellation='requested';});await activity.getByRole('button',{name:'Check execution status',exact:true}).click();await expect(activity).toContainText('Result not confirmed');await expect(activity).not.toContainText('awaiting confirmation');
 expect(await page.evaluate(()=>(window as any).refinement.calls.filter((x:any)=>x[0]==='act'||x[0]==='send'))).toEqual([]);
});
