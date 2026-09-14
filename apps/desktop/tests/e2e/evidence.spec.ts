import {test,expect,type Page} from '@playwright/test';
async function mount(page:Page,conversationOnly=false){
 await page.goto('/fixture.html');await page.evaluate(async conversationOnly=>{
  const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js',componentPath='/src/renderer/components/evidence-view.tsx';
  const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default,{EvidenceView}=await import(componentPath);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;(host as HTMLElement).style.minHeight='740px';host.innerHTML='<div class="ec-page" id="evidence-test"></div>';
  const reference={source:'session',ownerId:'s',artifactId:'a'};
  const artifact={reference,displayName:'Report.txt',mimeType:'text/plain',bytes:24,mediaKind:'document',integrity:'verified'};
  const preview={artifact,integrity:'verified',text:'Retained evidence output',truncated:false,reason:null};
  const state={disconnect:()=>{},update:()=>{},calls:0,opens:0,saves:0,delay:false,release:()=>{}};
  const api={artifacts:{get:async()=>{if(state.delay)await new Promise<void>(resolve=>state.release=resolve);return preview;},open:async()=>{state.opens++;return preview;},save:async()=>{state.saves++;return{saved:true};}},onSnapshot:(listener:any)=>{state.disconnect=()=>listener({status:'disconnected'});state.update=()=>listener({status:'ready',profile:{id:'p'}});state.update();return()=>{};},evidence:{get:async()=>{state.calls++;return({workId:'session:s',state:conversationOnly?'unverified':'partial',completion:'completed',artifacts:conversationOnly?[]:[reference],summaryCode:'partial',limitationCodes:conversationOnly?['conversation_only']:[],facts:conversationOnly?[]:[{callId:'write',tool:'file.write',kind:'mutation',verifiedBy:'check'},{callId:'publish',tool:'browser.action',kind:'unverified_mutation',verifiedBy:null}],truncated:false});}}};
  createRoot(document.querySelector('#evidence-test')!).render(React.createElement(EvidenceView,{api,work:{id:'session:s',profileId:'p',updatedAt:1}}));(window as any).evidenceTest=state;
 },conversationOnly);
}
test('Results names retained outputs and distinguishes recorded changes from verification',async({page})=>{
 await mount(page);await expect(page.getByRole('heading',{name:'Recorded changes',exact:true})).toBeVisible();await expect(page.getByText(/1.* verified .*1.* unverified change records/)).toBeVisible();
 await expect(page.getByText(/validated by/)).not.toBeVisible();await page.getByText('Recorded checks',{exact:true}).click();await expect(page.getByText(/validated by/)).toBeVisible();
 expect(await page.evaluate(()=>(window as any).evidenceTest.opens)).toBe(0);
 await page.getByRole('button',{name:'Open Report.txt',exact:true}).click();await expect(page.getByText('Retained evidence output')).toBeVisible();
 await page.getByRole('button',{name:'Save a copy…',exact:true}).click();expect(await page.evaluate(()=>(window as any).evidenceTest.saves)).toBe(1);
 await page.evaluate(()=>(window as any).evidenceTest.update());await expect(page.getByText('Retained evidence output')).toBeVisible();expect(await page.evaluate(()=>(window as any).evidenceTest.calls)).toBe(1);
 await page.getByRole('button',{name:'Refresh evidence'}).click();await expect.poll(()=>page.evaluate(()=>(window as any).evidenceTest.calls)).toBe(2);await expect(page.getByText('Retained evidence output')).toHaveCount(0);
 await page.screenshot({path:test.info().outputPath('results.png')});
 await page.setViewportSize({width:360,height:800});await expect.poll(()=>page.getByRole('region',{name:'Completion and evidence'}).evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
 await page.evaluate(()=>(window as any).evidenceTest.disconnect());await expect(page.getByText('Evidence disconnected.')).toBeVisible();await expect(page.getByRole('heading',{name:'Recorded changes',exact:true})).toHaveCount(0);
});
test('a conversation-only outcome does not invent external actions or verification controls',async({page})=>{
 await mount(page,true);await expect(page.getByText('This exchange produced a conversation response. No external changes were recorded.')).toBeVisible();
 await expect(page.getByRole('heading',{name:'Recorded changes',exact:true})).toHaveCount(0);await expect(page.getByText('Unverified evidence',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Verify',exact:true})).toHaveCount(0);
});
test('metadata arriving after disconnection cannot restore stale artifacts',async({page})=>{
 await mount(page);await expect(page.getByRole('button',{name:'Open Report.txt',exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).evidenceTest.delay=true);await page.getByRole('button',{name:'Refresh evidence'}).click();await expect(page.getByText('Loading artifacts…')).toBeVisible();
 await page.evaluate(()=>{const state=(window as any).evidenceTest;state.disconnect();state.release();});await expect(page.getByText('Evidence disconnected.')).toBeVisible();await expect(page.getByRole('button',{name:'Open Report.txt',exact:true})).toHaveCount(0);
});
