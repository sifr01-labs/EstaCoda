import {test,expect} from '@playwright/test';
async function mount(page:import('@playwright/test').Page,workspace=false){await page.goto('/fixture.html');await page.evaluate(async(workspace)=>{
 const react='/node_modules/.vite/deps/react.js',dom='/node_modules/.vite/deps/react-dom_client.js',path='/src/renderer/components/browser-takeover.tsx';
 const React=(await import(react)).default,{createRoot}=(await import(dom)).default,{BrowserTakeover}=await import(path);
 const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<div class="ec-filedialog ec-browserdialog" id="takeover-test"></div>';
 const canvas=document.createElement('canvas');canvas.width=600;canvas.height=320;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#edf0f2';ctx.fillRect(0,0,600,320);ctx.fillStyle='#147dab';ctx.font='24px sans-serif';ctx.fillText('Browser under human control',28,60);
 const state={calls:[] as any[],unmount:()=>{},defer:false,resolve:()=>{}},frame={frameId:'frame',url:'https://example.com',title:'Page',image:canvas.toDataURL('image/jpeg').split(',')[1],observedAt:'2026-09-12T12:00:00Z',submitTargets:[{ref:'@e3',label:'Log in'}]};
 const api={open:async()=>{state.calls.push('open');return{id:'handle'};},frame:async(_id:string,input:any)=>{state.calls.push(input??'observe');return state.defer?new Promise(resolve=>{state.resolve=()=>resolve(frame);}):frame;},release:async()=>{state.calls.push('release');},abandon:async()=>{state.calls.push('abandon');}};
 if(workspace)Object.assign(api,{signIn:async(...args:any[])=>{state.calls.push({signIn:args});return {submitted:true};},inventory:async()=>({supported:true,reason:null,truncated:false,sessions:[]}),openWorkspace:api.open,workspace:async(_id:string,operation:any)=>{state.calls.push(operation);return{supported:true,reason:null,truncated:false,selectedSessionId:'b',sessions:operation.kind==='list'?[]:[{id:'b',tabs:[{ref:'@t1',title:'Page',url:operation.url??frame.url,controlled:true,closable:false}]}]};}});
 const root=createRoot(document.getElementById('takeover-test')!);state.unmount=()=>root.render(null);root.render(React.createElement(BrowserTakeover,{api,workId:'session:s',reference:{sessionId:'s',browserId:'b',eventId:1,target:{targetId:'t',targetGeneration:1}},active:()=>{}}));(window as any).takeover=state;
 },workspace);}
test('uses fresh frames for pointer and keyboard input and returns control explicitly',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'Take control',exact:true}).click();await expect(page.getByRole('button',{name:'Return to agent'})).toBeVisible();await page.getByRole('button',{name:'Refresh live view'}).click();const viewport=page.getByRole('group',{name:'Controlled browser viewport'});await expect(viewport).toBeVisible();await page.getByRole('img',{name:'Live sanitized browser viewport'}).click({position:{x:100,y:100}});await expect(viewport).toHaveAttribute('aria-busy','false');await viewport.dispatchEvent('keydown',{key:'ب'});await expect(viewport).toHaveAttribute('aria-busy','false');await viewport.dispatchEvent('keydown',{key:'r',ctrlKey:true});
 const calls=await page.evaluate(()=>(window as any).takeover.calls);expect(calls[0]).toBe('open');expect(calls[1]).toBe('observe');expect(calls[2]).toMatchObject({kind:'pointer',frameId:'frame'});expect(calls[3]).toEqual({kind:'key',frameId:'frame',key:'ب'});expect(calls).toHaveLength(4);await page.screenshot({path:test.info().outputPath('takeover.png')});
 await page.getByRole('button',{name:'Return to agent'}).click();await expect(page.getByText('Control returned to the agent.')).toBeVisible();await page.evaluate(()=>(window as any).takeover.unmount());expect(await page.evaluate(()=>(window as any).takeover.calls.at(-1))).toBe('release');
});
test('abandoning drops late frames and does not resume the agent',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'Take control',exact:true}).click();await page.evaluate(()=>(window as any).takeover.defer=true);await page.getByRole('button',{name:'Refresh live view'}).click();await page.evaluate(()=>{(window as any).takeover.unmount();});await page.evaluate(()=>(window as any).takeover.resolve());await expect(page.getByRole('img',{name:'Live sanitized browser viewport'})).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>(window as any).takeover.calls)).toEqual(['open','observe','abandon']);
});

test('keeps workspace navigation disabled until takeover and creates a session semantically',async({page})=>{
 await mount(page,true);const address=page.getByRole('textbox',{name:'Browser address'});await expect(address).toBeDisabled();
 await page.getByRole('button',{name:'Take control',exact:true}).click();await expect(address).toBeEnabled();await address.fill('https://example.com');await page.getByRole('button',{name:'Open session',exact:true}).click();
 await expect(page.getByRole('button',{name:'Go',exact:true})).toBeEnabled();expect(await page.evaluate(()=>(window as any).takeover.calls)).toEqual(['open',{kind:'list'},{kind:'create',url:'https://example.com'}]);
 await page.getByRole('button',{name:'Return to agent'}).click();await expect(address).toBeDisabled();
});

test('requests protected sign-in with field references and never collects a password in the ordinary UI',async({page})=>{
 await mount(page,true);await page.getByRole('button',{name:'Take control',exact:true}).click();await page.getByRole('button',{name:'Refresh live view'}).click();
 await page.getByRole('combobox',{name:'Sign-in submit button'}).selectOption('@e3');await page.getByRole('button',{name:'Enter securely'}).click();
 await expect(page.getByText('Entry submitted. Refresh the live view to check the result.')).toBeVisible();
 expect(await page.evaluate(()=>(window as any).takeover.calls.at(-1))).toEqual({signIn:['handle','frame','@e3','password']});await expect(page.locator('input[type=password]')).toHaveCount(0);
 await expect(page.getByRole('img',{name:'Live sanitized browser viewport'})).toHaveCount(0);
});
