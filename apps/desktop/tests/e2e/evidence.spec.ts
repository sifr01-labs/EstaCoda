import {test,expect} from '@playwright/test';
test('shows verified receipt relationships and clears them on disconnect',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
  const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js',componentPath='/src/renderer/components/evidence-view.tsx';
  const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default,{EvidenceView}=await import(componentPath);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;(host as HTMLElement).style.minHeight='740px';host.innerHTML='<div class="ec-page" id="evidence-test"></div>';
  const state={disconnect:()=>{},update:()=>{},calls:0};const api={artifacts:{open:async()=>({artifact:{displayName:'Report.txt'},integrity:'verified',text:'Retained evidence output',truncated:false,reason:null})},onSnapshot:(listener:any)=>{state.disconnect=()=>listener({status:'disconnected'});state.update=()=>listener({status:'ready',profile:{id:'p'},work:{items:[{id:'session:other',updatedAt:2}]}});state.update();return()=>{};},evidence:{get:async()=>{state.calls++;return({workId:'session:s',state:'verified',completion:'completed',artifacts:[{source:'session',ownerId:'s',artifactId:'a'}],summary:'Recorded executions satisfy the reported completion requirement.',facts:[{callId:'write',tool:'file.write',kind:'mutation',verifiedBy:'check'}],limitations:[],truncated:false});}}};
  createRoot(document.querySelector('#evidence-test')!).render(React.createElement(EvidenceView,{api,work:{id:'session:s',profileId:'p',updatedAt:1}}));(window as any).evidenceTest=state;
 });
 await expect(page.getByText('Verified evidence',{exact:true})).toBeVisible();await expect(page.getByText(/validated by/)).toBeVisible();await page.getByRole('button',{name:'Preview retained output 1'}).click();await expect(page.getByText('Retained evidence output')).toBeVisible();expect(await page.evaluate(()=>(window as any).evidenceTest.calls)).toBe(1);
 await page.evaluate(()=>(window as any).evidenceTest.update());await expect(page.getByText('Retained evidence output')).toBeVisible();expect(await page.evaluate(()=>(window as any).evidenceTest.calls)).toBe(1);
 await page.getByRole('button',{name:'Refresh evidence'}).click();await expect.poll(()=>page.evaluate(()=>(window as any).evidenceTest.calls)).toBe(2);await expect(page.getByText('Retained evidence output')).toBeVisible();
 await page.screenshot({path:test.info().outputPath('evidence.png')});
 await page.setViewportSize({width:360,height:800});await expect.poll(()=>page.getByRole('region',{name:'Completion and evidence'}).evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
 await page.evaluate(()=>(window as any).evidenceTest.disconnect());await expect(page.getByText('Evidence disconnected.')).toBeVisible();await expect(page.getByText('Verified evidence',{exact:true})).toHaveCount(0);
});
