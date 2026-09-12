import {test,expect} from '@playwright/test';
test('shows verified receipt relationships and clears them on disconnect',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
  const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js',componentPath='/src/renderer/components/evidence-view.tsx';
  const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default,{EvidenceView}=await import(componentPath);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;(host as HTMLElement).style.minHeight='740px';host.innerHTML='<div class="ec-page" id="evidence-test"></div>';
  const state={disconnect:()=>{}};const api={onSnapshot:(listener:any)=>{state.disconnect=()=>listener({status:'disconnected'});return()=>{};},evidence:{get:async()=>({workId:'session:s',state:'verified',completion:'completed',summary:'Recorded executions satisfy the reported completion requirement.',facts:[{callId:'write',tool:'file.write',kind:'mutation',verifiedBy:'check'}],limitations:[],truncated:false})}};
  createRoot(document.querySelector('#evidence-test')!).render(React.createElement(EvidenceView,{api,work:{id:'session:s',profileId:'p',updatedAt:1}}));(window as any).evidenceTest=state;
 });
 await expect(page.getByText('Verified evidence',{exact:true})).toBeVisible();await expect(page.getByText(/validated by/)).toBeVisible();await page.screenshot({path:test.info().outputPath('evidence.png')});
 await page.evaluate(()=>(window as any).evidenceTest.disconnect());await expect(page.getByText('Evidence disconnected.')).toBeVisible();await expect(page.getByText('Verified evidence',{exact:true})).toHaveCount(0);
});
