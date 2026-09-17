import {test,expect,type Page} from '@playwright/test';
async function mount(page:Page,fresh=false){
 await page.goto('/fixture.html');await page.evaluate(async fresh=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',wp='/src/renderer/components/work-view.tsx',pp='/src/renderer/appearance.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{WorkView}=await import(wp),{AppearanceProvider}=await import(pp);
  const target={targetId:'t',targetGeneration:1,label:'Project',isolation:'host'},work={id:'session:s',canonicalId:'s',profileId:'p',title:'Conversation',kind:'session',status:'completed',updatedAt:1,target,actions:[{id:'sessions.send',enabled:true}]};
  const state={calls:[] as any[],items:[] as any[],release:()=>{},fail:()=>{},refresh:()=>{},remount:()=>{},draft:null as any};(window as any).deliveryTest=state;
  const api={activity:async()=>({items:state.items,nextCursor:null}),work:{targets:async()=>({items:[target],truncated:false}),children:async()=>({items:[],nextCursor:null}),live:async()=>({active:false,text:'',turnId:null,truncated:false}),inspect:async()=>null,submit:async(input:any)=>{state.calls.push(input);return new Promise((resolve,reject)=>{state.release=()=>resolve({workId:work.id,receipt:{method:'sessions.send',state:'dispatched'}});state.fail=()=>reject(Error('Reply lost'));});}}};
  const adapter={kind:'live',api};
  function Harness(){const [version,setVersion]=React.useState(0);state.remount=()=>setVersion((v:number)=>v+1);const [current,setCurrent]=React.useState(fresh?undefined:work),[draft,setDraft]=React.useState({id:'draft',text:'',attachments:[],target,model:'Kimi K3',note:''}),[view,setView]=React.useState({tab:'activity',inspector:false,activityExtent:100});state.draft=draft;state.refresh=()=>setCurrent({...work,updatedAt:Date.now()});return React.createElement(WorkView,{key:version,adapter,work:current,draft,change:setDraft,view,changeView:(v:any)=>setView({...view,...v}),profile:'p',attention:[],pinned:false,togglePin:()=>{},models:()=>{},select:(_id:string,submitted:any)=>{if(submitted)setDraft({...submitted,text:'',attachments:[],id:'next'});setCurrent({...work});}});}
  const host=document.querySelector('.ec-window')!;host.innerHTML='';createRoot(host).render(React.createElement(AppearanceProvider,{store:{read:async()=>({theme:'kemet',appearance:'dark',density:'comfortable',language:'en'}),write:async()=>{}}},React.createElement(Harness)));
 },fresh);
}
for(const fresh of [false,true])test(`message appears before acknowledgment and reconciles with history (${fresh?'new':'existing'} chat)`,async({page})=>{
 await mount(page,fresh);const input=page.getByLabel('Draft guidance');await input.fill('Review this design');await page.getByRole('button',{name:'Send prompt',exact:true}).click();
 await expect(page.getByRole('status',{name:'Sending message…'})).toContainText('Review this design');await expect(input).toHaveValue('');
 expect(await page.evaluate(()=>(window as any).deliveryTest.calls)).toHaveLength(1);
 await page.evaluate(()=>(window as any).deliveryTest.release());await expect(page.getByRole('status',{name:'Message sent'})).toBeVisible();
 await page.evaluate(()=>{const s=(window as any).deliveryTest;s.items=[{id:'m',kind:'message',role:'user',text:'Review this design',workId:'session:s',profileId:'p',sequence:1,timestamp:Date.now()}];s.refresh();});
 await expect(page.locator('.ec-pending-message')).toHaveCount(0);await expect(page.getByText('Review this design',{exact:true})).toHaveCount(1);
});
test('lost reply keeps the draft and does not automatically resend',async({page})=>{
 await mount(page);const input=page.getByLabel('Draft guidance');await input.fill('Keep this message');await page.getByRole('button',{name:'Send prompt',exact:true}).click();
 await expect(page.getByRole('status',{name:'Sending message…'})).toBeVisible();await page.evaluate(()=>(window as any).deliveryTest.fail());
 await expect(page.getByRole('status',{name:'Delivery unconfirmed'})).toContainText('Keep this message');await expect(input).toHaveValue('Keep this message');
 await expect(page.getByRole('button',{name:'Check status',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Send prompt',exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).deliveryTest.calls)).toHaveLength(1);
});
test('an identical earlier message does not swallow the new message preview',async({page})=>{
 await mount(page);await page.evaluate(()=>{const s=(window as any).deliveryTest;s.items=[{id:'earlier',kind:'message',role:'user',text:'Continue',workId:'session:s',profileId:'p',sequence:1,timestamp:Date.now()}];s.refresh();});
 await expect(page.getByText('Continue',{exact:true})).toBeVisible();await page.getByLabel('Draft guidance').fill('Continue');await page.getByRole('button',{name:'Send prompt',exact:true}).click();
 await expect(page.getByRole('status',{name:'Sending message…'})).toContainText('Continue');await expect(page.getByText('Continue',{exact:true})).toHaveCount(2);
});

test('returning to a chat during a send reconciles without replaying the message',async({page})=>{
 await mount(page);await page.getByLabel('Draft guidance').fill('Keep my place');await page.getByRole('button',{name:'Send prompt',exact:true}).click();
 await expect(page.getByRole('status',{name:'Sending message…'})).toBeVisible();await page.evaluate(()=>(window as any).deliveryTest.remount());
 await expect(page.getByRole('status',{name:'Delivery unconfirmed'})).toBeVisible();await expect(page.getByLabel('Draft guidance')).toHaveValue('Keep my place');
 await page.getByRole('button',{name:'Check status',exact:true}).click();expect(await page.evaluate(()=>(window as any).deliveryTest.calls)).toHaveLength(2);
 expect(await page.evaluate(()=>(window as any).deliveryTest.calls[1].inspectOnly)).toBe(true);
 await page.evaluate(()=>(window as any).deliveryTest.release());await expect(page.getByRole('status',{name:'Message sent'})).toBeVisible();
});
