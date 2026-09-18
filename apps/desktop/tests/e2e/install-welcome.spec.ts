import {test,expect} from '@playwright/test';

for(const existing of [false,true])test(`welcome offers both choices with ${existing?'existing':'fresh'} setup`,async({page})=>{
 await page.goto('/fixture.html');
 await page.evaluate(async(existing)=>{
  const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default,{InstallWelcome}=await import('/src/renderer/components/install-welcome.tsx');
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<main id="welcome-test"></main>';
  const state={acknowledged:0,complete:'',connect:existing};(window as any).welcomeTest=state;
  const api={profiles:async()=>[{id:'default',label:'default'}],installation:{inspect:async()=>({profileId:'default',configuration:{state:existing?'configured-ready':'new-user',mode:existing?'ready':'first-run'},runtime:'stopped',compatibility:'compatible',canConnect:state.connect}),acknowledge:async()=>{state.acknowledged++;}}};
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

for(const language of ['en','ar'] as const)test(`profile selection and separate setup review preserve cancellation (${language})`,async({page})=>{
 await page.goto('/fixture.html');
 await page.evaluate(async(language)=>{
  const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default,{InstallWelcome}=await import('/src/renderer/components/install-welcome.tsx'),{AppearanceProvider}=await import('/src/renderer/appearance.tsx');
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<main id="welcome-test"></main>';host.setAttribute('dir',language==='ar'?'rtl':'ltr');
  const appearance={read:async()=>({theme:'kemet',appearance:'light',density:'comfortable',language}),write:async()=>{}};
  const state={profile:'cli',acknowledged:0,creates:0,cancels:0,blocked:true,complete:''};(window as any).welcomeTest=state;
  function Harness(){const[profile,setProfile]=React.useState('cli');const api=React.useMemo(()=>({profiles:async()=>['cli','default',...(state.creates?['desktop']:[])].map(id=>({id,label:id})),switchProfile:async(id:string)=>{state.profile=id;setProfile(id);},installation:{inspect:async()=>({profileId:state.profile,configuration:{state:state.profile==='desktop'?'new-user':'configured-ready',mode:state.profile==='desktop'?'first-run':'ready'},runtime:state.blocked?'incompatible':'stopped',compatibility:state.blocked?'incompatible':'compatible',canConnect:!state.blocked&&state.profile!=='desktop'}),acknowledge:async()=>{state.acknowledged++;}},settings:{reviewAction:async(action:any)=>({reviewId:'review',action,facts:[],expiresAt:Date.now()+60000}),cancelAction:async()=>{state.cancels++;},executeAction:async()=>{state.creates++;return{state:'completed'};}}}),[]);return React.createElement(AppearanceProvider,{store:appearance},React.createElement(InstallWelcome,{api,snapshot:{status:'ready',profile:{id:profile,label:profile}},complete:(mode:string)=>{state.complete=mode;},repair:()=>{}}));}
  createRoot(document.getElementById('welcome-test')!).render(React.createElement(Harness));
 },language);
 const ar=language==='ar',button=(en:string,arabic:string)=>page.getByRole('button',{name:ar?arabic:en,exact:true});
 await button('Use existing EstaCoda','استخدام إعداد EstaCoda الحالي').click();
 await expect(button('Continue with existing setup','متابعة بالإعداد الحالي')).toBeDisabled();
 await expect(page.getByRole('combobox',{name:ar?'الإعداد المحلي':'Local setup',exact:true})).toHaveValue('cli');
 await page.evaluate(()=>{(window as any).welcomeTest.blocked=false;});
 await page.getByRole('combobox',{name:ar?'الإعداد المحلي':'Local setup',exact:true}).selectOption('default');
 await expect(button('Continue with existing setup','متابعة بالإعداد الحالي')).toBeEnabled();
 await button('Set up EstaCoda','إعداد EstaCoda').click();
 await page.getByRole('textbox',{name:ar?'اسم الإعداد المنفصل':'Separate setup name'}).fill('desktop');
 await button('Review separate setup','مراجعة الإعداد المنفصل').click();
 expect(await page.evaluate(()=>(window as any).welcomeTest.creates)).toBe(0);
 await button('Back','رجوع').click();
 expect(await page.evaluate(()=>(window as any).welcomeTest)).toMatchObject({creates:0,cancels:1,acknowledged:0});
 await button('Set up EstaCoda','إعداد EstaCoda').click();
 await button('Review separate setup','مراجعة الإعداد المنفصل').click();
 await page.screenshot({path:test.info().outputPath('review-'+language+'.png')});
 await button('Confirm separate setup','تأكيد الإعداد المنفصل').click();
 await expect(button('Begin setup','بدء الإعداد')).toBeEnabled();
 await button('Begin setup','بدء الإعداد').click();
 expect(await page.evaluate(()=>(window as any).welcomeTest)).toMatchObject({creates:1,acknowledged:1,profile:'desktop',complete:'fresh'});
});
