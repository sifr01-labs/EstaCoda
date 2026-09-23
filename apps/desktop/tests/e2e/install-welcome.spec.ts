import {test,expect} from '@playwright/test';
import {translate,type MessageKey} from '../../src/shared/i18n/index.js';
for(const language of ['en','ar'] as const)test(`welcome opens an existing setup or creates one in one step (${language})`,async({page})=>{
 await page.goto('/fixture.html');
 await page.evaluate(async(language)=>{
  const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default,{InstallWelcome}=await import('/src/renderer/components/install-welcome.tsx'),{AppearanceProvider}=await import('/src/renderer/appearance.tsx');
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<main id="welcome-test"></main>';host.setAttribute('dir',language==='ar'?'rtl':'ltr');
  const appearance={read:async()=>({theme:'kemet',appearance:'light',density:'comfortable',language}),write:async()=>{}};
  const state={profile:'cli',acknowledged:0,creates:0,blocked:true,complete:''};(window as any).welcomeTest=state;
  function Harness(){const[profile,setProfile]=React.useState('cli');const api=React.useMemo(()=>({profiles:async()=>['cli','default',...(state.creates?['desktop']:[])].map(id=>({id,label:id})),switchProfile:async(id:string)=>{state.profile=id;setProfile(id);},installation:{inspect:async()=>({profileId:state.profile,configuration:{state:state.profile==='desktop'?'new-user':'configured-ready',mode:state.profile==='desktop'?'first-run':'ready'},runtime:state.blocked?'incompatible':'stopped',compatibility:state.blocked?'incompatible':'compatible',canConnect:!state.blocked&&state.profile!=='desktop'}),acknowledge:async()=>{state.acknowledged++;}},settings:{reviewAction:async(action:any)=>({reviewId:'review',action,facts:[],expiresAt:Date.now()+60000}),cancelAction:async()=>({cancelled:true}),executeAction:async()=>{state.creates++;return{state:'completed'};}}}),[]);return React.createElement(AppearanceProvider,{store:appearance},React.createElement(InstallWelcome,{api,snapshot:{status:'ready',profile:{id:profile,label:profile}},complete:(mode:string)=>{state.complete=mode;},repair:()=>{}}));}
  createRoot(document.getElementById('welcome-test')!).render(React.createElement(Harness));
 },language);
 const t=(key:MessageKey)=>translate(language,key),button=(key:MessageKey)=>page.getByRole('button',{name:t(key),exact:true});
 await expect(page.getByRole('img',{name:'ESTACODA',exact:true})).toBeVisible();
 await page.getByRole('button',{name:new RegExp(t('Use an existing setup'))}).click();
 await expect(button('Open EstaCoda')).toBeDisabled();await expect(button('Open Settings')).toBeVisible();
 await page.evaluate(()=>{(window as any).welcomeTest.blocked=false;});await page.getByRole('combobox',{name:t('Existing setup')}).selectOption('default');
 await expect(button('Open EstaCoda')).toBeEnabled();await expect(button('Open Settings')).toHaveCount(0);
 await button('Back').click();await page.getByRole('button',{name:new RegExp(t('Start fresh'))}).click();
 await page.getByRole('textbox',{name:t('Setup name')}).fill('desktop');
 await button('Back').click();expect(await page.evaluate(()=>(window as any).welcomeTest.creates)).toBe(0);
 await page.getByRole('button',{name:new RegExp(t('Start fresh'))}).click();
 await page.screenshot({path:test.info().outputPath('welcome-'+language+'.png')});
 await button('Continue').click();
 await expect.poll(()=>page.evaluate(()=>(window as any).welcomeTest)).toMatchObject({creates:1,acknowledged:1,profile:'desktop',complete:'fresh'});
});
