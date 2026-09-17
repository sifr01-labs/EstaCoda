import {test, expect, type Page} from '@playwright/test';

// Production components, with deferred synthetic reads. Never preload or real state.
async function mount(page: Page, mode: 'primitives'|'files'|'artifacts'|'live') {
  await page.goto('/fixture.html');
  await page.evaluate(async mode => {
    const rp='/node_modules/.vite/deps/react.js', dp='/node_modules/.vite/deps/react-dom_client.js';
    const React=(await import(rp)).default, {createRoot}=(await import(dp)).default;
    const loaderPath='/src/renderer/components/loading.tsx', filePath='/src/renderer/components/file-browser.tsx';
    const artifactPath='/src/renderer/components/live-artifacts.tsx', livePath='/src/renderer/components/live-activity.tsx';
    const i18nPath='/src/renderer/i18n.tsx';
    const {ActivityIndicator, SkeletonRows}=await import(loaderPath), {LanguageContext}=await import(i18nPath);
    const {FileBrowser}=await import(filePath), {LiveArtifacts}=await import(artifactPath), {LiveActivity}=await import(livePath);
    const host=document.querySelector('#ec-branded-workspace .ec-window')!;
    host.innerHTML='<div class="ec-page" id="loading-test"></div>';
    const root=createRoot(document.getElementById('loading-test')!);
    const tasks:Record<string, {resolve:(v:any)=>void;reject:()=>void}[]>={};
    const defer=(name:string)=>new Promise((resolve,reject)=>{(tasks[name]??=[]).push({resolve,reject:()=>reject(Error('Unavailable'))});});
    const state={profile:'p',ready:true,language:'en',waiting:false,status:'running',generation:1,
      preview:{active:true,turnId:'turn',text:'Received response',truncated:false},
      finish:(name:string,value:any)=>tasks[name]?.shift()?.resolve(value),
      fail:(name:string)=>tasks[name]?.shift()?.reject(),
      count:(name:string)=>tasks[name]?.length??0,
      render:()=>{},disconnect:()=>{}};
    const api={onSnapshot:(fn:any)=>{state.disconnect=()=>fn({status:'disconnected',profile:{id:state.profile}});return()=>{};},
      files:{list:()=>defer('files'),preview:()=>defer('preview')},
      artifacts:{list:()=>defer('artifacts'),open:()=>defer('artifact')},live:async()=>state.preview};
    state.render=()=>root.render(React.createElement(LanguageContext.Provider,{value:state.language},
      mode==='primitives'?React.createElement('section',{'aria-label':'Loader specimens'},
        React.createElement(ActivityIndicator,{variant:'dots'}),React.createElement(ActivityIndicator),React.createElement(SkeletonRows,{label:'Loading artifacts…'})):
      mode==='files'?React.createElement(FileBrowser,{api,target:{targetId:'t',targetGeneration:1},close:()=>root.render(null)}):
      mode==='artifacts'?React.createElement(LiveArtifacts,{key:state.profile,api,profile:state.profile,status:state.ready?'ready':'disconnected',select:()=>{}}):
      React.createElement(LiveActivity,{key:state.generation,api,waiting:state.waiting,work:{id:'session:s',kind:'session',status:state.status,target:{targetId:'t',targetGeneration:state.generation}}})));
    (window as any).loaderTest=state;state.render();
  },mode);
}

test('approved motion, geometry, themes, RTL and reduced motion',async({page})=>{
  await page.emulateMedia({reducedMotion:'no-preference'});
  await mount(page,'primitives');
  const dots=page.locator('.ec-loading-dots i'), orbit=page.locator('.ec-loading-satellites');
  await expect(dots).toHaveCount(3);
  await expect(dots.first()).toHaveCSS('animation-duration','1.5s');
  await expect(orbit).toHaveCSS('animation-duration','1.65s');
  await expect(page.locator('.ec-loading-bone').first()).toHaveCSS('animation-duration','2.475s');
  await expect(page.locator('.ec-loading-orbit')).toHaveCSS('width','22px');
  await expect(dots.first()).toHaveCSS('width','4px');
  await expect(page.locator('.ec-loading-row').first()).toHaveCSS('height','68px');
  await expect(page.locator('.ec-loading-delayed')).toHaveCSS('animation-delay','0.18s');
  const first=await orbit.evaluate(el=>getComputedStyle(el).transform);
  await expect.poll(()=>orbit.evaluate(el=>getComputedStyle(el).transform)).not.toBe(first);
  await expect(page.locator('#loading-test').getByRole('status')).toHaveText('Loading artifacts…');
  for(const theme of ['kemet','graphite','sand'])for(const mode of ['light','dark'])for(const width of [736,360]){
    await page.setViewportSize({width,height:800});
    await page.evaluate(({theme,mode})=>{const host=document.getElementById('ec-branded-workspace')!;host.dataset.theme=theme;host.dataset.appearance=mode;host.dir='rtl';},{theme,mode});
    await expect.poll(()=>page.locator('#loading-test').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await expect(page.locator('.ec-loading-bone').first()).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)');
    if(theme==='kemet')await expect(page.locator('.ec-loading-bone').first()).toHaveCSS('background-color',mode==='light'?'rgb(224, 228, 225)':'rgb(48, 52, 48)');
    if(theme==='kemet'&&width===736)await page.locator('#loading-test').screenshot({path:test.info().outputPath('loaders-'+mode+'.png')});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(dots.first()).toHaveCSS('animation-name','none');
  await expect(orbit).toHaveCSS('animation-name','none');
  await expect(page.locator('.ec-loading-bone').first()).toHaveCSS('animation-name','none');
  await expect(page.locator('.ec-loading-delayed')).toHaveCSS('visibility','visible');
});

test('file skeletons settle on success, failure and disconnect',async({page})=>{
  await mount(page,'files');
  await expect(page.locator('#loading-test').getByRole('status')).toHaveText('Loading files…');
  await page.evaluate(()=>{(window as any).loaderTest.finish('files',{items:[{name:'app.ts',path:'app.ts',kind:'file'}],truncated:false});});
  await page.getByRole('button',{name:'app.ts',exact:true}).click();
  await expect(page.locator('#loading-test').getByRole('status')).toHaveText('Loading preview…');
  await page.evaluate(()=>(window as any).loaderTest.fail('preview'));
  await expect(page.getByRole('alert')).toContainText('Preview unavailable');
  await expect(page.locator('.ec-loading-rows')).toHaveCount(0);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.locator('#loading-test').getByRole('status')).toHaveText('Loading files…');
  await page.evaluate(()=>(window as any).loaderTest.disconnect());
  await expect(page.getByRole('alert')).toContainText('Files disconnected');
  await page.evaluate(()=>(window as any).loaderTest.finish('files',{items:[{name:'stale.ts',path:'stale.ts',kind:'file'}]}));
  await expect(page.locator('.ec-loading-rows')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'stale.ts',exact:true})).toHaveCount(0);
});

test('artifact refresh keeps rows; profile change discards rows and late reads',async({page})=>{
  await mount(page,'artifacts');
  await expect(page.locator('#loading-test').getByRole('status')).toHaveText('Loading artifacts…');
  await page.evaluate(()=>(window as any).loaderTest.finish('artifacts',{items:[{reference:{source:'session',ownerId:'s',artifactId:'a'},displayName:'Report.txt',mimeType:'text/plain',retention:'retained'}],nextCursor:'more'}));
  await page.getByRole('button',{name:'Refresh artifacts'}).click();
  await expect(page.getByRole('button',{name:/Report.txt/})).toBeVisible();
  await expect(page.locator('.ec-loading-rows')).toHaveCount(0);
  await expect(page.locator('.ec-loading-status')).toBeVisible();
  await page.evaluate(()=>{const s=(window as any).loaderTest;s.profile='q';s.render();});
  await expect(page.getByRole('button',{name:/Report.txt/})).toHaveCount(0);
  await expect(page.locator('.ec-loading-rows')).toBeVisible();
  await page.evaluate(()=>(window as any).loaderTest.finish('artifacts',{items:[{displayName:'Late private report'}],nextCursor:null}));
  await expect(page.getByText('Late private report')).toHaveCount(0);
  await page.evaluate(()=>(window as any).loaderTest.fail('artifacts'));
  await expect(page.getByRole('alert')).toHaveText('Artifacts could not be loaded.');
  await expect(page.locator('.ec-loading-rows')).toHaveCount(0);
});

test('working indicator follows owner activity, suppress attention, localize, and clear on settlement',async({page})=>{
  await mount(page,'live');
  await expect(page.locator('.ec-working-word')).toBeVisible();
  await page.evaluate(()=>{const s=(window as any).loaderTest;s.waiting=true;s.render();});
  await expect(page.locator('.ec-working-word')).toHaveCount(0);
  await expect(page.getByText('Received response')).toBeVisible();
  await page.evaluate(()=>{const s=(window as any).loaderTest;s.waiting=false;s.status='paused';s.render();});
  await expect(page.locator('.ec-working-word')).toHaveCount(0);
  await page.evaluate(()=>{const s=(window as any).loaderTest;s.status='running';s.language='ar';s.render();});
  await expect(page.locator('.ec-working-word')).toBeVisible();
  await expect(page.locator('#loading-test').getByRole('status')).toHaveText('جارٍ العمل');
  await page.evaluate(()=>{const s=(window as any).loaderTest;s.preview={active:false,turnId:null,text:'',truncated:false};s.generation++;s.render();});
  await expect(page.locator('.ec-working-word')).toHaveCount(0);
  await expect(page.getByText('Received response')).toHaveCount(0);
});

test('working presence animates the brand mark, keeps text steady, and respects reduced motion',async({page},info)=>{
 await mount(page,'live');const mark=page.locator('.ec-working-presence .ec-official-icon');await expect(mark).toBeVisible();
 await page.emulateMedia({reducedMotion:'no-preference'});await expect(mark).toHaveCSS('animation-name','ec-presence-breathe');await expect(page.locator('.ec-working-word')).toHaveCSS('animation-name','none');await expect(page.locator('.ec-working-word')).toHaveCSS('background-image','none');
 await page.screenshot({path:info.outputPath('working-presence.png')});await page.emulateMedia({reducedMotion:'reduce'});await expect(mark).toHaveCSS('animation-name','none');await expect(mark).toBeVisible();
});
