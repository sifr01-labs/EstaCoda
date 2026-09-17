import {test,expect,type Page} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';

async function mount(page:Page,{language='en',mode='dark',scenario='files'}:{language?:'en'|'ar';mode?:'light'|'dark';scenario?:'files'|'error'|'missing'}={}){
 await page.goto(`/fixture.html?language=${language}&mode=${mode}`);
 await page.evaluate(async({language,scenario})=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',lp='/src/renderer/i18n.tsx',cp='/src/renderer/components/changes-view.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{LanguageContext}=await import(lp),{ChangesView}=await import(cp);
  const host=document.querySelector('.ec-window')!;host.innerHTML='<main id="changes-test" style="width:100%;max-width:1040px;padding:24px;margin:0 auto;box-sizing:border-box"></main>';
  const state={scenario,listCalls:0,patchCalls:[] as any[],disconnect:()=>{},resolveSlow:(_value:any)=>{}};(window as any).changesTest=state;
  const api={onSnapshot:(listener:any)=>{state.disconnect=()=>listener({status:'disconnected'});return()=>{};},diff:{
   list:async()=>{state.listCalls++;if(state.scenario==='error')throw Error('private backend detail');if(state.scenario==='clean')return{items:[],truncated:false};return{items:[
    {path:'src/composer.tsx',previousPath:null,stage:'unstaged',status:'modified',previewable:true},
    {path:'src/renamed.ts',previousPath:'src/original.ts',stage:'staged',status:'renamed',previewable:true},
    {path:'image.png',previousPath:null,stage:'unstaged',status:'modified',previewable:true},
    {path:'blocked-link',previousPath:null,stage:'untracked',status:'added',previewable:false},
   ],truncated:true};},
   patch:async(args:any)=>{state.patchCalls.push(args);if(args.path==='src/renamed.ts')return new Promise(resolve=>{state.resolveSlow=resolve;});if(args.path==='image.png')return{binary:true,text:null,truncated:false};if(state.scenario==='patchError')throw Error('private path');return{binary:false,text:'diff --git a/src/composer.tsx b/src/composer.tsx\n--- a/src/composer.tsx\n+++ b/src/composer.tsx\n@@ -1,2 +1,2 @@\n-const label = "Before";\n+const label = "After العربية";\n '+('long line '.repeat(30)),truncated:true};}
  }};
  createRoot(document.querySelector('#changes-test')!).render(React.createElement(LanguageContext.Provider,{value:language},React.createElement(ChangesView,{api,target:scenario==='missing'?null:{targetId:'workspace',targetGeneration:4}})));
 },{language,scenario});
}

test('unavailable and missing workspace states recover without exposing backend errors',async({page})=>{
 await mount(page,{scenario:'error'});await expect(page.getByRole('heading',{name:'Changes aren’t available'})).toBeVisible();await expect(page.locator('body')).not.toContainText('private backend detail');
 await page.screenshot({path:'/private/tmp/estacoda-changes-unavailable.png'});
 await page.evaluate(()=>(window as any).changesTest.scenario='clean');await page.getByRole('button',{name:'Refresh changes'}).click();await expect(page.getByRole('heading',{name:'No changes to review'})).toBeVisible();
 await mount(page,{scenario:'missing'});await expect(page.getByRole('heading',{name:'A Git workspace is needed'})).toBeVisible();await expect(page.getByRole('button',{name:'Refresh changes'})).toBeDisabled();expect(await page.evaluate(()=>(window as any).changesTest.listCalls)).toBe(0);
});

for(const language of ['en','ar'] as const)test(`read-only review, stale responses, and responsive layout ${language}`,async({page})=>{
 await page.setViewportSize({width:1280,height:900});await mount(page,{language,mode:language==='en'?'dark':'light'});
 const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 await expect(page.getByRole('button',{name:/blocked-link/})).toBeDisabled();await page.getByRole('button',{name:/src\/composer.tsx/}).click();
 const patch=page.getByRole('region',{name:t('File preview')});await expect(patch).toContainText('+const label = "After العربية";');expect(await page.locator('.ec-changes-code').evaluate(e=>getComputedStyle(e).direction)).toBe('ltr');
 await expect(page.getByText(t('This patch is truncated. Some changes are not displayed.'))).toBeVisible();await expect(page.getByText(t('First 32 changes shown. Additional changes are not displayed.'))).toBeVisible();
 expect(await page.evaluate(()=>(window as any).changesTest.patchCalls[0])).toEqual({target:{targetId:'workspace',targetGeneration:4},path:'src/composer.tsx',stage:'unstaged'});
 await page.screenshot({path:`/private/tmp/estacoda-changes-${language}.png`});
 await page.setViewportSize({width:360,height:900});expect(await page.locator('#changes-test').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await page.screenshot({path:`/private/tmp/estacoda-changes-${language}-narrow.png`});
 await page.getByRole('button',{name:/src\/renamed.ts/}).click();await page.getByRole('button',{name:/image.png/}).click();await expect(page.getByRole('heading',{name:t('Binary file changed')})).toBeVisible();await page.evaluate(()=>(window as any).changesTest.resolveSlow({binary:false,text:'stale preview',truncated:false}));await expect(patch).not.toContainText('stale preview');
 await page.evaluate(()=>(window as any).changesTest.scenario='patchError');await page.getByRole('button',{name:/src\/composer.tsx/}).click();await expect(page.getByRole('heading',{name:t('Preview unavailable')})).toBeVisible();await expect(page.getByRole('button',{name:/image.png/})).toBeVisible();await expect(page.locator('body')).not.toContainText('private path');
 await page.evaluate(()=>(window as any).changesTest.disconnect());await expect(page.getByRole('heading',{name:t('Changes disconnected')})).toBeVisible();await expect(page.getByRole('button',{name:t('Refresh changes')})).toBeDisabled();await expect(page.locator('.ec-changes-code')).toHaveCount(0);
});
