import {test,expect} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';
for(const language of ['en','ar'] as const)for(const databaseIssue of ['upgrade_required','newer_schema'] as const){
 test(`${language}: ${databaseIssue} explains recovery and does not poll Connections`,async({page})=>{
  await page.goto('/fixture.html');
  await page.evaluate(async({language,databaseIssue})=>{
   const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js';
   const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default;
   const appPath='/src/renderer/app.tsx',appearancePath='/src/renderer/appearance.tsx';
   const {App}=await import(appPath),{AppearanceProvider}=await import(appearancePath);
   document.getElementById('root')!.remove();const host=document.createElement('div');document.body.append(host);
   const snapshot={status:'unavailable',databaseIssue,profile:{id:'default',label:'default',configuration:'unconfigured'},runtime:'unavailable',work:{items:[],nextCursor:null},inbox:{items:[],nextCursor:null}};
   const state={calls:0,reconnects:0};(window as any).recoveryTest=state;
   const api={onSnapshot:(listener:any)=>{listener(snapshot);return()=>{};},reconnect:async()=>{state.reconnects++;},connections:{list:async()=>{state.calls++;throw new Error('Unavailable');}}};
   (window as any).desktop=api;
   const adapter={kind:'live',api,appearance:{read:async()=>({theme:'kemet',appearance:'light',density:'comfortable',language}),write:async()=>{}}};
   createRoot(host).render(React.createElement(AppearanceProvider,{store:adapter.appearance},React.createElement(App,{adapter})));
  },{language,databaseIssue});
  const heading=translate(language,databaseIssue==='upgrade_required'?'Database upgrade required':'Newer app required');
  await expect(page.getByRole('heading',{name:heading})).toBeVisible();
  await page.getByRole('button',{name:translate(language,'Connections'),exact:true}).click();
  await expect(page.getByRole('heading',{name:heading})).toBeVisible();
  await page.clock.install();await page.clock.fastForward(16000);
  expect(await page.evaluate(()=>(window as any).recoveryTest.calls)).toBe(0);
  await page.getByRole('button',{name:translate(language,'Reconnect'),exact:true}).click();
  expect(await page.evaluate(()=>(window as any).recoveryTest.reconnects)).toBe(1);
 });
}
