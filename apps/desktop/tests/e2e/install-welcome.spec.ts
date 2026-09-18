import {test,expect} from '@playwright/test';

for(const existing of [false,true])test(`welcome offers both choices with ${existing?'existing':'fresh'} setup`,async({page})=>{
 await page.goto('/fixture.html');
 await page.evaluate(async(existing)=>{
  const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default,{InstallWelcome}=await import('/src/renderer/components/install-welcome.tsx');
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<main id="welcome-test"></main>';
  const state={acknowledged:0,complete:'',connect:existing};(window as any).welcomeTest=state;
  const api={installation:{inspect:async()=>({profileId:'default',configuration:{state:existing?'configured-ready':'new-user',mode:existing?'ready':'first-run'},runtime:'stopped',compatibility:'compatible',canConnect:state.connect}),acknowledge:async()=>{state.acknowledged++;}}};
  createRoot(document.getElementById('welcome-test')!).render(React.createElement(InstallWelcome,{api,snapshot:{status:'ready',profile:{id:'default',label:'default'}},complete:(mode:string)=>{state.complete=mode;},repair:()=>{}}));
 },existing);
 await expect(page.getByRole('button',{name:'Set up EstaCoda',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Use existing EstaCoda',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Set up EstaCoda',exact:true}).click();
 if(existing){await expect(page.getByRole('button',{name:'Begin setup',exact:true})).toBeDisabled();await page.getByRole('button',{name:'Use existing EstaCoda',exact:true}).click();}
 expect(await page.evaluate(()=>(window as any).welcomeTest.acknowledged)).toBe(0);
 await page.getByRole('button',{name:existing?'Continue with existing setup':'Begin setup',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).welcomeTest)).toMatchObject({acknowledged:1,complete:existing?'existing':'fresh'});
 await page.screenshot({path:test.info().outputPath('welcome.png')});
});
