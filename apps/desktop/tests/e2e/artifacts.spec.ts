import {test,expect} from '@playwright/test';
test('browses retained output, renders text safely and scopes source navigation',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
  const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js',componentPath='/src/renderer/components/live-artifacts.tsx';
  const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default,{LiveArtifacts}=await import(componentPath);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;(host as HTMLElement).style.minHeight='740px';host.innerHTML='<div class="ec-page" id="artifact-test"></div>';
  const artifact={reference:{source:'session',ownerId:'s',artifactId:'a'},displayName:'Quarterly report.txt',mimeType:'text/plain',bytes:80,sha256:'a'.repeat(64),createdAt:'2026-09-12',retention:'retained',sourceOrigin:'https://example.com',workIds:['session:s'],target:null};
  const state={disconnect:()=>{},selected:'',foreign:false};const api={getWork:async(id:string)=>({id,profileId:state.foreign?'other':'p'}),onSnapshot:(listener:any)=>{state.disconnect=()=>listener({status:'disconnected'});return()=>{};},artifacts:{list:async()=>({items:[artifact],nextCursor:null}),open:async()=>({artifact,integrity:'verified',text:'<img src=x onerror=alert(1)>\nA retained report.',reason:null,truncated:true})}};
  createRoot(document.querySelector('#artifact-test')!).render(React.createElement(LiveArtifacts,{api,profile:'p',status:'ready',select:(id:string)=>{state.selected=id;}}));(window as any).artifactTest=state;
 });
 await page.getByRole('button',{name:/Quarterly report/}).click();await expect(page.getByText(/<img src=x/)).toBeVisible();await expect(page.getByText('Integrity verified',{exact:true})).toBeVisible();await page.screenshot({path:test.info().outputPath('artifact.png')});
 await page.getByRole('button',{name:'Open source Work'}).click();expect(await page.evaluate(()=>(window as any).artifactTest.selected)).toBe('session:s');
 await page.getByRole('button',{name:'All artifacts'}).click();await expect(page.getByRole('button',{name:/Quarterly report/})).toBeFocused();
 await page.evaluate(()=>(window as any).artifactTest.disconnect());await expect(page.getByText('Artifacts disconnected.')).toBeVisible();await expect(page.getByRole('button',{name:/Quarterly report/})).toHaveCount(0);
});
