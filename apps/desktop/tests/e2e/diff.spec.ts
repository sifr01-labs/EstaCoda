import {test,expect} from '@playwright/test';
test('groups changes by stage and shows renames, binary metadata and disconnect state',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js',componentPath='/src/renderer/components/changes-view.tsx';
 const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default,{ChangesView}=await import(componentPath);
 const host=document.querySelector('#ec-branded-workspace .ec-window')!;(host as HTMLElement).style.minHeight='740px';host.innerHTML='<div id="diff-test"></div>';
 const state={disconnect:()=>{}};const api={onSnapshot:(listener:any)=>{state.disconnect=()=>listener({status:'disconnected'});return()=>{};},diff:{list:async()=>({items:[{path:'new.ts',previousPath:'old.ts',stage:'staged',status:'renamed',binary:null,previewable:true},{path:'image.bin',previousPath:null,stage:'unstaged',status:'modified',binary:null,previewable:true}],truncated:true}),patch:async({path,stage}:any)=>({path,stage,binary:path==='image.bin',text:path==='image.bin'?null:'-old\n+new',truncated:false})}};
 createRoot(document.querySelector('#diff-test')!).render(React.createElement(ChangesView,{api,target:{targetId:'t',targetGeneration:1}}));(window as any).diffTest=state;
 });await expect(page.getByText('Staged',{exact:true})).toBeVisible();await page.getByRole('button',{name:/old.ts → new.ts/}).click();await expect(page.getByText('+new',{exact:true})).toBeVisible();await page.screenshot({path:test.info().outputPath('changes.png')});await page.getByRole('button',{name:/image.bin/}).click();await expect(page.getByText('Binary file changed. Text patch unavailable.')).toBeVisible();await page.evaluate(()=>(window as any).diffTest.disconnect());await expect(page.getByText(/Changes disconnected/)).toBeVisible();await expect(page.getByRole('button',{name:/image.bin/})).toHaveCount(0);
});
