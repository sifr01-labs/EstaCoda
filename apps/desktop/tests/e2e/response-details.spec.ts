import {test,expect,type Page} from '@playwright/test';

async function mount(page:Page,options:{language?:string;appearance?:string;failures?:number;ready?:boolean;compact?:boolean}={}){
 await page.goto('/fixture.html');
 await page.evaluate(async options=>{
  const paths={react:'/node_modules/.vite/deps/react.js',dom:'/node_modules/.vite/deps/react-dom_client.js',appearance:'/src/renderer/appearance.tsx',actions:'/src/renderer/components/work-actions.tsx',response:'/src/renderer/components/response-details.tsx'};
  const React=(await import(paths.react)).default,{createRoot}=(await import(paths.dom)).default,{AppearanceProvider}=await import(paths.appearance),{WorkActions}=await import(paths.actions),{ResponseDetails}=await import(paths.response);
  document.getElementById('root')!.remove();const root=document.createElement('div');document.body.append(root);
  const listeners=new Set<any>();
  const state={reads:[] as string[],writes:[] as any[],failures:options.failures??0,ready:options.ready??true,profileId:'p',receipt:'dispatched',hold:false,late:[] as any[],loseAction:false,update:(_value:any)=>{},snapshot:()=>{}};
  const snapshot=()=>({status:state.ready?'ready':'reconnecting',profile:{id:state.profileId}});
  const observe=(listener:any)=>{listeners.add(listener);listener(snapshot());return()=>listeners.delete(listener);};state.snapshot=()=>listeners.forEach(listener=>listener(snapshot()));
  const api={inspect:async(id:string)=>{state.reads.push(id);if(state.hold)return new Promise(resolve=>state.late.push(resolve));if(state.failures-->0)throw Error('Private diagnostic must not render');return {method:'sessions.send',state:state.receipt,cancellation:'not_requested'};},act:async(input:any)=>{state.writes.push(input);if(state.loseAction)throw Error('Lost acknowledgement');return {method:'sessions.cancelTurn',state:'completed',cancellation:'requested'};}};
  const base={workId:'session:a',profileId:'p',timestamp:1726408800000,sequence:0};
  const events=['attempting','failed','attempting','failed','attempting','responded','attempting','responded'].map((status,index)=>({...base,id:`m${index}`,timestamp:base.timestamp+index*1000,kind:'model',executionModel:{providerId:index<4?'kimi':'codex',modelId:index<4?'kimi-k3':'gpt-5.5',fallback:index>=4,state:status}}));
  const routes=['intent-skills','capabilities'].map((stage,index)=>({...base,id:`r${index}`,kind:'routing',routing:{stage,configuredMode:'jev-assisted',actualEngine:'jev',partialFallback:true,fallbackReason:'uncertain'}}));
  function Harness(){
   const [work,setWork]=React.useState({id:'session:a',profileId:'p',kind:'session',title:'Review the workspace',status:'running',actions:[{id:'sessions.cancelTurn',enabled:true}]});state.update=(value:any)=>setWork((old:any)=>({...old,...value}));
   return React.createElement('main',{style:{width:'min(850px, 100%)',margin:'40px auto',padding:'16px',boxSizing:'border-box',background:'var(--ec-bg)',color:'var(--ec-text)'}},React.createElement('h2',null,'Response details'),React.createElement('p',null,'The response used Jev-assisted routing. Standard resolved uncertain selections.'),React.createElement(ResponseDetails,{items:[...events,...routes],active:false,answered:true}),React.createElement('div',{id:'ec-operation-details'}),React.createElement('div',{id:'ec-work-attention'}),React.createElement(WorkActions,{api,work,observe,inspectDetails:true,compact:options.compact}));
  }
  (window as any).responseTest=state;
  createRoot(root).render(React.createElement(AppearanceProvider,{store:{read:async()=>({theme:'kemet',appearance:options.appearance??'light',density:'comfortable',language:options.language??'en'}),write:async()=>{}}},React.createElement(Harness)));
 },options);
 await expect(page.locator('.ec-workcontrols')).toBeVisible();
}
const reads=(page:Page)=>page.evaluate(()=>(window as any).responseTest.reads.length);
const advance=async(page:Page,ms:number)=>{await page.clock.runFor(ms);};

test('failed polling recovers without a mutation or contradictory pending notice',async({page})=>{
 await page.clock.install();await mount(page);await expect(page.getByText('Request accepted; waiting for the execution owner.')).toBeVisible();
 await page.evaluate(()=>{const s=(window as any).responseTest;s.failures=1;});await advance(page,1500);
 await expect(page.getByRole('alert')).toContainText(['Could not refresh request status.','Could not refresh request status.']);await expect(page.getByText('Request accepted; waiting for the execution owner.')).toHaveCount(0);
 await page.evaluate(()=>(window as any).responseTest.receipt='completed');await advance(page,1500);
 await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByText('Request completed',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).responseTest.writes)).toEqual([]);
});

test('retries are bounded and settlement, focus, manual refresh and reconnect restart observations',async({page})=>{
 await page.clock.install();await mount(page,{failures:100});await expect.poll(()=>reads(page)).toBe(1);
 for(const ms of [1500,3000,6000])await advance(page,ms);expect(await reads(page)).toBe(4);await advance(page,30000);expect(await reads(page)).toBe(4);
 await page.evaluate(()=>{const s=(window as any).responseTest;s.failures=0;s.receipt='completed';s.update({status:'completed'});});await expect(page.getByRole('alert')).toHaveCount(0);expect(await reads(page)).toBe(5);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>reads(page)).toBe(6);
 await page.getByRole('button',{name:'Check execution status',exact:true}).click();await expect.poll(()=>reads(page)).toBe(7);
 await page.evaluate(()=>{const s=(window as any).responseTest;s.ready=false;s.snapshot();});await expect(page.getByRole('alert')).toContainText(['Could not refresh request status.','Could not refresh request status.']);
 await page.evaluate(()=>{const s=(window as any).responseTest;s.ready=true;s.snapshot();});await expect(page.getByRole('alert')).toHaveCount(0);expect(await reads(page)).toBe(8);
 await page.evaluate(()=>(window as any).responseTest.snapshot());expect(await reads(page)).toBe(8);
});

test('stale observations cannot overwrite a new chat, profile, or connection',async({page})=>{
 await page.clock.install();await mount(page);await page.evaluate(()=>{const s=(window as any).responseTest;s.hold=true;window.dispatchEvent(new Event('focus'));});await expect.poll(()=>page.evaluate(()=>(window as any).responseTest.late.length)).toBe(1);
 await page.evaluate(()=>{const s=(window as any).responseTest;s.hold=false;s.receipt='completed';s.profileId='q';s.update({id:'session:b',profileId:'q',status:'completed'});});await expect(page.getByText('Request completed',{exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).responseTest.late[0]({method:'sessions.send',state:'uncertain'}));await expect(page.getByText('Result not confirmed',{exact:true})).toHaveCount(0);
 // A response from before disconnect must also be ignored after reconnection.
 await page.evaluate(()=>{const s=(window as any).responseTest;s.hold=true;window.dispatchEvent(new Event('focus'));});await expect.poll(()=>page.evaluate(()=>(window as any).responseTest.late.length)).toBe(2);
 await page.evaluate(()=>{const s=(window as any).responseTest;s.ready=false;s.snapshot();s.hold=false;s.ready=true;s.snapshot();});await expect(page.getByText('Request completed',{exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).responseTest.late[1]({method:'sessions.send',state:'unknown'}));await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByText('Result not confirmed',{exact:true})).toHaveCount(0);
});

test('lost action acknowledgments trigger reads only and uncertain outcomes remain visible',async({page})=>{
 await page.clock.install();await mount(page);await page.evaluate(()=>(window as any).responseTest.loseAction=true);await page.getByRole('button',{name:'Stop',exact:true}).click();await expect(page.getByRole('alert')).toContainText(['The action is not confirmed.','The action is not confirmed.']);
 await page.evaluate(()=>(window as any).responseTest.receipt='uncertain');await advance(page,1500);await expect(page.getByText('Result not confirmed',{exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).responseTest.writes.length)).toBe(1);
 await advance(page,30000);expect(await page.evaluate(()=>(window as any).responseTest.writes.length)).toBe(1);
});

test('compact status recovery clears the request warning without changing work outcome or permissions',async({page})=>{
 await page.clock.install();await mount(page,{failures:1,compact:true});
 await expect(page.getByLabel('Request status unavailable',{exact:true})).toBeVisible();
 await page.evaluate(()=>{const s=(window as any).responseTest;s.receipt='completed';s.update({status:'completed',actions:[{id:'sessions.resume',enabled:false,reason:'Approval required'}]});});
 await expect(page.getByLabel('Request status unavailable',{exact:true})).toHaveCount(0);await expect(page.locator('.ec-current-state')).toHaveText('Completed');
 expect(await page.evaluate(()=>(window as any).responseTest.writes)).toEqual([]);
 // A denied action stays disabled when the work is still awaiting authorization.
 await page.evaluate(()=>(window as any).responseTest.update({status:'needs_attention'}));await page.getByLabel('More actions',{exact:true}).click();await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeDisabled();await expect(page.locator('.ec-current-state')).toHaveText('Needs attention');
});

test('initial disconnect waits for the correct profile before checking',async({page})=>{
 await mount(page,{ready:false});await expect(page.getByRole('alert')).toContainText(['Could not refresh request status.','Could not refresh request status.']);expect(await reads(page)).toBe(0);
 await page.evaluate(()=>{const s=(window as any).responseTest;s.ready=true;s.profileId='other';s.snapshot();});expect(await reads(page)).toBe(0);
 await page.evaluate(()=>{const s=(window as any).responseTest;s.profileId='p';s.snapshot();});await expect.poll(()=>reads(page)).toBe(1);await expect(page.getByRole('alert')).toHaveCount(0);
});

for(const language of ['en','ar'])for(const appearance of ['light','dark'])test(`response disclosure hierarchy, keyboard and layout ${language} ${appearance}`,async({page})=>{
 await mount(page,{language,appearance});const card=page.locator('.ec-run-details');await expect(card).not.toHaveAttribute('open','');
 await card.locator(':scope > summary').focus();await page.keyboard.press('Enter');await expect(card).toHaveAttribute('open','');await expect(card.locator('.ec-response-facts')).toBeVisible();await expect(card.locator('.ec-response-model').first()).toBeHidden();
 await card.locator('.ec-response-technical > summary').click();await expect(card.locator('.ec-response-model')).toHaveCount(2);await card.locator('.ec-response-model > summary').last().click();await expect(card.locator('.ec-response-model').last().locator('li')).toHaveCount(4);
 if(language==='en'){expect((await card.textContent())!.replace(/[\u2068\u2069]/g,'')).toContain('Completed calls: 2');expect((await card.textContent())!.replace(/[\u2068\u2069]/g,'')).toContain('Failed calls: 2');await expect(card).not.toContainText('Answered with');}
 await page.screenshot({path:`/tmp/response-details-${language}-${appearance}.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`/tmp/response-details-${language}-${appearance}-narrow.png`,fullPage:true});
});
