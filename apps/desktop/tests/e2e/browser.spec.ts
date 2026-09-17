import {test,expect} from '@playwright/test';
async function mount(page:import('@playwright/test').Page){
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js',componentPath='/src/renderer/components/browser-view.tsx';
 const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default,{BrowserView}=await import(componentPath);
 const host=document.querySelector('#ec-branded-workspace .ec-window')!;(host as HTMLElement).style.minHeight='740px';host.innerHTML='<button id="openbrowser">Open browser</button><div id="browser-test"></div>';
 const canvas=document.createElement('canvas');canvas.width=960;canvas.height=640;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#e9edf0';ctx.fillRect(0,0,960,640);ctx.fillStyle='#147dab';ctx.font='28px sans-serif';ctx.fillText('Recorded browser viewport',50,70);
 const reference={sessionId:'s',browserId:'b',eventId:1,target:{targetId:'t',targetGeneration:1}},item={reference,url:'https://example.com/document',title:'Documentation',observedAt:'2026-09-12T12:00:00Z',readiness:'complete',state:'recorded',lastAction:'browser.snapshot',artifacts:[{id:'a'}]};
 const preview={state:item,image:{mimeType:'image/jpeg',base64:canvas.toDataURL('image/jpeg').split(',')[1],observedAt:item.observedAt},reason:null};
 const state={disconnect:()=>{},profile:()=>{},defer:false,resolve:()=>{},calls:[] as string[]};
 const api={onSnapshot:(listener:any)=>{state.disconnect=()=>listener({status:'disconnected'});state.profile=()=>listener({status:'ready',profile:{id:'other'}});return()=>{};},browser:{list:async()=>{state.calls.push('list');return{items:[item],truncated:false};},snapshot:async()=>{state.calls.push('snapshot');return state.defer?new Promise(resolve=>{state.resolve=()=>resolve(preview);}):preview;}},artifacts:{open:async()=>({artifact:{displayName:'Browser output'},integrity:'verified',text:'<img src=x onerror=alert(1)>',truncated:false})}};
 const root=createRoot(document.querySelector('#browser-test')!);document.getElementById('openbrowser')!.onclick=()=>root.render(React.createElement(BrowserView,{api,work:{id:'session:s',kind:'session',profileId:'p',target:reference.target},close:()=>root.render(null)}));(window as any).browserTest=state;
 });await page.getByRole('button',{name:'Open browser',exact:true}).click();
}
test('shows bounded recorded state, inert output and restores focus',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'Documentation',exact:true}).click();await expect(page.getByRole('img',{name:'Sanitized recorded browser viewport'})).toBeVisible();await expect(page.getByText('https://example.com/document')).toBeVisible();await expect(page.locator('.ec-workspace-panel iframe, .ec-workspace-panel webview, .ec-workspace-panel a')).toHaveCount(0);
 await page.getByRole('button',{name:'Inspect Work artifact 1'}).click();await expect(page.getByText('<img src=x onerror=alert(1)>')).toBeVisible();await expect(page.locator('.ec-workspace-panel img')).toHaveCount(1);await page.screenshot({path:test.info().outputPath('browser.png')});
 await page.getByRole('button',{name:'Refresh browser view'}).click();await expect(page.getByRole('img',{name:'Sanitized recorded browser viewport'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Documentation',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.getByRole('complementary')).toHaveCount(0);await expect(page.getByRole('button',{name:'Open browser',exact:true})).toBeFocused();expect(await page.evaluate(()=>(window as any).browserTest.calls)).toEqual(['list','snapshot','list']);
});
for(const invalidation of ['disconnect','profile'] as const)test(`drops late captures on ${invalidation}`,async({page})=>{
 await mount(page);await page.evaluate(()=>(window as any).browserTest.defer=true);await page.getByRole('button',{name:'Documentation',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect Work artifact 1'})).toBeDisabled();await page.evaluate(kind=>{(window as any).browserTest[kind]();(window as any).browserTest.resolve();},invalidation);await expect(page.getByRole('alert')).toContainText('disconnected');await expect(page.locator('.ec-workspace-panel img')).toHaveCount(0);await expect(page.getByText('https://example.com/document')).toHaveCount(0);await expect(page.getByRole('button',{name:'Refresh browser view'})).toBeDisabled();
});
test('contains browser preview at narrow widths',async({page})=>{
 await page.setViewportSize({width:360,height:800});await mount(page);await page.getByRole('button',{name:'Documentation',exact:true}).click();await expect(page.getByRole('img',{name:'Sanitized recorded browser viewport'})).toBeVisible();expect(await page.locator('.ec-workspace-panel').evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
});
