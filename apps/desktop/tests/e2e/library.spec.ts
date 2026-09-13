import {test,expect} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';
for(const language of ['en','ar'] as const)test('Library browsing stays scoped and safe '+language,async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async language=>{
  const react='/node_modules/.vite/deps/react.js',dom='/node_modules/.vite/deps/react-dom_client.js',component='/src/renderer/components/live-library.tsx',context='/src/renderer/i18n.tsx';
  const React=(await import(react)).default,{createRoot}=(await import(dom)).default,{LiveLibrary}=await import(component),{LanguageContext}=await import(context);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<div id="library-test"></div>';
  const skill={id:'s',name:'Example skill',description:'Visible capability',source:'local',version:null,requiredToolsets:['files'],optionalToolsets:[]};
  const state={disconnect:()=>{}};const api={onSnapshot:(listener:any)=>{state.disconnect=()=>listener({profile:{id:'other'},status:'ready'});return()=>{};},library:{skills:async()=>({items:[skill],nextOffset:null}),skill:async()=>({skill,instructions:'<script>unsafe</script>',truncated:false}),memory:async()=>({items:[{kind:'MEMORY.md',scope:'profile',content:'Profile-only note',truncated:false}]}),proposals:async()=>({items:[],nextOffset:null})}};
  createRoot(document.querySelector('#library-test')!).render(React.createElement(LanguageContext.Provider,{value:language},React.createElement(LiveLibrary,{api,profile:'one',connection:'ready',select:()=>{}})));(window as any).libraryTest=state;
 },language);const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 await page.setViewportSize({width:360,height:900});await page.getByRole('button',{name:t('Skills & tools'),exact:true}).click();expect(await page.locator('.ec-live-library').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);await page.getByRole('button',{name:/Example skill/}).click();await expect(page.getByText('<script>unsafe</script>',{exact:true})).toBeVisible();await page.getByRole('button',{name:t('Memory'),exact:true}).click();await expect(page.getByText('Profile-only note')).toBeVisible();await page.evaluate(()=>(window as any).libraryTest.disconnect());await expect(page.getByText(t('Library disconnected.'))).toBeVisible();await expect(page.getByText('Profile-only note')).toHaveCount(0);
});
