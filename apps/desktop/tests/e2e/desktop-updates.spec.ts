import {test,expect} from '@playwright/test';
for(const language of ['en','ar'])for(const appearance of ['light','dark'])test(`update choices preserve intent in ${language} ${appearance}`,async({page})=>{
 await page.setViewportSize({width:appearance==='dark'?380:1100,height:850});await page.goto('/fixture.html');
 await page.evaluate(async({language,appearance})=>{
  const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default,{AppearanceProvider}=await import('/src/renderer/appearance.tsx'),{DesktopUpdatesControl}=await import('/src/renderer/components/desktop-updates.tsx');
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<main id="updates-test"></main>';
  const state={phase:'available',version:'1.0.0',availableVersion:'1.1.0',installation:{ownership:'owned',canReplace:true},automaticChecks:false};const calls={downloads:0,installs:0,cancels:0};(window as any).updatesTest={state,calls};
  const api={status:async()=>({...state}),check:async()=>({...state}),preferences:async(automaticChecks:boolean)=>({...state,automaticChecks}),download:async()=>{calls.downloads++;state.phase='ready';return {...state};},install:async()=>{calls.installs++;state.phase='installing';return {...state};},cancel:async()=>{calls.cancels++;return {...state};},notes:async()=>{}};
  createRoot(document.getElementById('updates-test')!).render(React.createElement(AppearanceProvider,{store:{read:async()=>({theme:'kemet',appearance,density:'comfortable',language}),write:async()=>{}}},React.createElement(DesktopUpdatesControl,{api})));
 },{language,appearance});
 const ar=language==='ar',button=(en:string,arabic:string)=>page.getByRole('button',{name:ar?arabic:en,exact:true});
 await button('App updates','تحديثات التطبيق').click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();expect(await page.evaluate(()=>(window as any).updatesTest.calls.downloads)).toBe(0);
 const box=await dialog.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 await page.screenshot({path:test.info().outputPath('updates.png')});await button('Download update','تنزيل التحديث').click();await expect(dialog.getByRole('button',{name:ar?'إعادة التشغيل للتحديث':'Restart to update'})).toBeVisible();
 await button('Later','لاحقًا').click();await expect(dialog).not.toBeVisible();expect(await page.evaluate(()=>(window as any).updatesTest.calls)).toEqual({downloads:1,installs:0,cancels:0});
 await button('Restart to update','إعادة التشغيل للتحديث').click();await expect(dialog).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(button('Restart to update','إعادة التشغيل للتحديث')).toBeFocused();
 await button('Restart to update','إعادة التشغيل للتحديث').click();await dialog.getByRole('button',{name:ar?'إعادة التشغيل للتحديث':'Restart to update'}).click();expect(await page.evaluate(()=>(window as any).updatesTest.calls.installs)).toBe(1);
});
