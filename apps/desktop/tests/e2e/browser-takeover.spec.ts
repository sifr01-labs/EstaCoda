import {test,expect} from '@playwright/test';
async function mount(page:import('@playwright/test').Page,workspace=false,unsupported=false){await page.goto('/fixture.html');await page.evaluate(async({workspace,unsupported})=>{
 const react='/node_modules/.vite/deps/react.js',dom='/node_modules/.vite/deps/react-dom_client.js',path='/src/renderer/components/browser-takeover.tsx';
 const React=(await import(react)).default,{createRoot}=(await import(dom)).default,{BrowserTakeover}=await import(path);
 const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<div class="ec-filedialog ec-browserdialog" id="takeover-test"></div>';
 const canvas=document.createElement('canvas');canvas.width=600;canvas.height=320;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#edf0f2';ctx.fillRect(0,0,600,320);ctx.fillStyle='#147dab';ctx.font='24px sans-serif';ctx.fillText('Browser under human control',28,60);
 const state={calls:[] as any[],unmount:()=>{},defer:false,fail:false,fresh:false,resolve:()=>{}},frame={frameId:'frame',inputContextId:'field-1',url:'https://example.com',title:'Page',image:canvas.toDataURL('image/jpeg').split(',')[1],observedAt:'2026-09-12T12:00:00Z',submitTargets:[{ref:'@e3',label:'Log in'}]};
 Object.assign(state,{frame});
 const api={open:async()=>{state.calls.push('open');return{id:'handle'};},frame:async(_id:string,input:any)=>{state.calls.push(input??'observe');const reply=()=>({...frame,frameId:state.fresh?'frame-'+state.calls.length:frame.frameId});return state.defer?new Promise(resolve=>{state.resolve=()=>resolve(reply());}):reply();},release:async()=>{state.calls.push('release');},abandon:async()=>{state.calls.push('abandon');}};
 if(workspace)Object.assign(api,{signIn:async(...args:any[])=>{state.calls.push({signIn:args});return {submitted:true};},inventory:async()=>({supported:!unsupported,reason:unsupported?'This backend supports recorded viewing only.':null,truncated:false,sessions:[]}),openWorkspace:api.open,workspace:async(_id:string,operation:any)=>{state.calls.push(operation);if(state.fail)throw new Error('Uncertain action');return{supported:true,reason:null,truncated:false,selectedSessionId:'b',sessions:operation.kind==='list'?[]:[{id:'b',tabs:[{ref:'@t1',title:'Page',url:operation.url??frame.url,controlled:true,closable:false}]}]};}});
 const root=createRoot(document.getElementById('takeover-test')!);state.unmount=()=>root.render(null);root.render(React.createElement(BrowserTakeover,{api,workId:'session:s',reference:{sessionId:'s',browserId:'b',eventId:1,target:{targetId:'t',targetGeneration:1}},active:()=>{}}));(window as any).takeover=state;
 },{workspace,unsupported});}
test('uses fresh frames for pointer and keyboard input and returns control explicitly',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'Take control',exact:true}).click();await expect(page.getByRole('button',{name:'Return to agent'})).toBeVisible();await page.getByRole('button',{name:'Refresh live view'}).click();const viewport=page.getByRole('group',{name:'Controlled browser viewport'});await expect(viewport).toBeVisible();await page.getByRole('img',{name:'Live sanitized browser viewport'}).click({position:{x:100,y:100}});await expect(viewport).toHaveAttribute('aria-busy','false');await viewport.dispatchEvent('keydown',{key:'ب'});await expect(viewport).toHaveAttribute('aria-busy','false');await viewport.dispatchEvent('keydown',{key:'r',ctrlKey:true});
 const calls=await page.evaluate(()=>(window as any).takeover.calls);expect(calls[0]).toBe('open');expect(calls[1]).toBe('observe');expect(calls[2]).toMatchObject({kind:'pointer',frameId:'frame'});expect(calls[3]).toEqual({kind:'key',frameId:'frame',key:'ب'});expect(calls).toHaveLength(4);await page.screenshot({path:test.info().outputPath('takeover.png')});
 await page.getByRole('button',{name:'Return to agent'}).click();await expect(page.getByText('Control returned to the agent.')).toBeVisible();await page.evaluate(()=>(window as any).takeover.unmount());expect(await page.evaluate(()=>(window as any).takeover.calls.at(-1))).toBe('release');
});
test('abandoning drops late frames and does not resume the agent',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'Take control',exact:true}).click();await page.evaluate(()=>(window as any).takeover.defer=true);await page.getByRole('button',{name:'Refresh live view'}).click();await page.evaluate(()=>{(window as any).takeover.unmount();});await page.evaluate(()=>(window as any).takeover.resolve());await expect(page.getByRole('img',{name:'Live sanitized browser viewport'})).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>(window as any).takeover.calls)).toEqual(['open','observe','abandon']);
});

test('shows workspace navigation only during takeover and creates a session semantically',async({page})=>{
 await mount(page,true);const address=page.getByRole('textbox',{name:'Browser address'});await expect(address).toHaveCount(0);
 await page.getByRole('button',{name:'Take control',exact:true}).click();await expect(address).toBeEnabled();await address.fill('https://example.com');await page.getByRole('button',{name:'Open session',exact:true}).click();
 await expect(page.getByRole('button',{name:'Go',exact:true})).toBeEnabled();expect(await page.evaluate(()=>(window as any).takeover.calls)).toEqual(['open',{kind:'list'},{kind:'create',url:'https://example.com'}]);
 await page.getByRole('button',{name:'Return to agent'}).click();await expect(address).toHaveCount(0);
});

test('requests protected sign-in with field references and never collects a password in the ordinary UI',async({page})=>{
 await mount(page,true);await page.getByRole('button',{name:'Take control',exact:true}).click();await page.getByRole('button',{name:'Refresh live view'}).click();
 await page.getByRole('combobox',{name:'Sign-in submit button'}).selectOption('@e3');await page.getByRole('button',{name:'Enter securely'}).click();
 await expect(page.getByText('Entry submitted. Refresh the live view to check the result.')).toBeVisible();
 expect(await page.evaluate(()=>(window as any).takeover.calls.at(-1))).toEqual({signIn:['handle','frame','@e3','password']});await expect(page.locator('input[type=password]')).toHaveCount(0);
 await expect(page.getByRole('img',{name:'Live sanitized browser viewport'})).toHaveCount(0);
});

test('keeps unsupported backends view only without acquiring a lease',async({page})=>{
 await mount(page,true,true);await expect(page.getByText('This backend supports recorded viewing only.')).toBeVisible();await expect(page.getByRole('button',{name:'Take control',exact:true})).toBeDisabled();await expect(page.getByRole('textbox',{name:'Browser address'})).toHaveCount(0);expect(await page.evaluate(()=>(window as any).takeover.calls)).toEqual([]);
});
test('never retries an uncertain navigation or returns control implicitly',async({page})=>{
 await mount(page,true);await page.getByRole('button',{name:'Take control',exact:true}).click();await page.getByRole('textbox',{name:'Browser address'}).fill('https://example.com');await page.evaluate(()=>(window as any).takeover.fail=true);await page.getByRole('button',{name:'Open session',exact:true}).click();
 await expect(page.getByText(/Control unavailable or uncertain/)).toBeVisible();await expect(page.getByRole('textbox',{name:'Browser address'})).toHaveCount(0);expect(await page.evaluate(()=>(window as any).takeover.calls)).toEqual(['open',{kind:'list'},{kind:'create',url:'https://example.com'},'abandon']);
});
test('fits narrow windows and preserves theme styling around workspace controls',async({page})=>{
 await page.setViewportSize({width:420,height:900});await mount(page,true);await page.getByRole('button',{name:'Take control',exact:true}).click();await page.getByRole('textbox',{name:'Browser address'}).fill('https://example.com');await page.getByRole('button',{name:'Open session',exact:true}).click();
 expect(await page.locator('#takeover-test').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.screenshot({path:test.info().outputPath('browser-workspace-narrow.png')});
});

test('delivers rapid typing in order using each new frame',async({page})=>{
 await mount(page,true);await page.getByRole('button',{name:'Take control',exact:true}).click();await page.getByRole('button',{name:'Refresh live view'}).click();
 const viewport=page.getByRole('group',{name:'Controlled browser viewport'});await expect(viewport).toBeVisible();
 await page.evaluate(()=>{const state=(window as any).takeover;state.defer=true;state.fresh=true;});await viewport.dispatchEvent('keydown',{key:'a'});await expect(viewport).toHaveAttribute('aria-busy','true');
 await viewport.dispatchEvent('keydown',{key:'ب'});await viewport.dispatchEvent('keydown',{key:'c'});
 await page.evaluate(()=>{const state=(window as any).takeover;state.frame={...state.frame};state.defer=false;state.resolve();});
 await expect(viewport).toHaveAttribute('aria-busy','false');
 expect(await page.evaluate(()=>(window as any).takeover.calls.filter((c:any)=>c.kind==='key').map((c:any)=>[c.key,c.frameId]))).toEqual([['a','frame'],['ب','frame-4'],['c','frame-5']]);
});
test('discards queued text when focus changes and reports it',async({page})=>{
 await mount(page,true);await page.getByRole('button',{name:'Take control',exact:true}).click();await page.getByRole('button',{name:'Refresh live view'}).click();
 const viewport=page.getByRole('group',{name:'Controlled browser viewport'});await expect(viewport).toBeVisible();await page.evaluate(()=>(window as any).takeover.defer=true);
 await viewport.dispatchEvent('keydown',{key:'Tab'});await expect(viewport).toHaveAttribute('aria-busy','true');await viewport.dispatchEvent('keydown',{key:'x'});
 await page.evaluate(()=>{const state=(window as any).takeover;state.frame.inputContextId='different-field';state.resolve();});
 await expect(page.getByText(/Remaining queued text was not sent/)).toBeVisible();
 expect(await page.evaluate(()=>(window as any).takeover.calls.filter((c:any)=>c.kind==='key').map((c:any)=>c.key))).toEqual(['Tab']);
});
test('bounds typing and drops pending keys when the view closes',async({page})=>{
 await mount(page,true);await page.getByRole('button',{name:'Take control',exact:true}).click();await page.getByRole('button',{name:'Refresh live view'}).click();
 const viewport=page.getByRole('group',{name:'Controlled browser viewport'});await expect(viewport).toBeVisible();await page.evaluate(()=>(window as any).takeover.defer=true);
 await viewport.dispatchEvent('keydown',{key:'a'});await expect(viewport).toHaveAttribute('aria-busy','true');
 for(let i=0;i<65;i++)await viewport.dispatchEvent('keydown',{key:'b'});
 await expect(page.getByText(/Typing queue is full/)).toBeVisible();await page.evaluate(()=>{const state=(window as any).takeover;state.unmount();});await expect(viewport).toHaveCount(0);
 await page.evaluate(()=>(window as any).takeover.resolve());
 expect(await page.evaluate(()=>(window as any).takeover.calls.filter((c:any)=>c.kind==='key').map((c:any)=>c.key))).toEqual(['a']);
});
