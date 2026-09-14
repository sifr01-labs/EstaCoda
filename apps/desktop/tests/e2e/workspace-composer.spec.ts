import {test,expect,type Page} from '@playwright/test';
import {translate,type DisplayLanguage} from '../../src/shared/i18n/index.js';
async function mount(page:Page,language:DisplayLanguage='en'){
 await page.goto('/fixture.html');
 await page.evaluate(async language=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',ap='/src/renderer/app.tsx',pp='/src/renderer/appearance.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{App}=await import(ap),{AppearanceProvider}=await import(pp);
  document.getElementById('root')!.remove();const host=document.createElement('div');document.body.append(host);
  const listeners=new Set<any>();const old={id:'session:old',canonicalId:'old',kind:'session',title:'Earlier conversation',status:'completed',target:null,actions:[],updatedAt:1};
  const state={calls:[] as any[],items:[] as any[],inspectionPath:'/chosen/project-notes',cancelPicker:false,uncertain:false,ready:false,delayReview:false,release:()=>{},refresh:(profile='default',status='ready')=>{for(const listener of listeners)listener({...snapshot,status,profile:{...snapshot.profile,id:profile}});}};
  const target={targetId:'target',targetGeneration:1,label:'Project notes',isolation:'host',approvalMode:'strict'};
  const snapshot={status:'ready',profile:{id:'default',label:'default',configuration:'ready'},runtime:'ready',work:{items:[old],nextCursor:null},inbox:{items:[],nextCursor:null}};
  const api={targets:{inspect:async()=>({workingRoot:state.inspectionPath,readiness:'ready'})},platform:'darwin',onSnapshot:(listener:any)=>{listeners.add(listener);listener(snapshot);return()=>listeners.delete(listener);},profiles:async()=>[],getWork:async()=>old,activity:async()=>({items:[],nextCursor:null}),
   work:{targets:async(input:any)=>({items:input?.target?state.items.filter((item:any)=>item.targetId===input.target.targetId&&item.targetGeneration===input.target.targetGeneration):state.items,truncated:false}),pins:async()=>[],children:async()=>({items:[],nextCursor:null}),live:async()=>({active:false}),attach:async()=>{state.calls.push(['attach']);return[{id:'file',name:'notes.md',type:'text/plain',size:12}];},submit:async(input:any)=>{state.calls.push(['submit',input]);throw Error('Unconfirmed');}},
   onboarding:{chooseWorkspace:async()=>{state.calls.push(['choose']);return state.cancelPicker?null:{path:'/chosen/project-notes',alias:'project-notes'};},reviewWorkspace:async(alias:string,trust:boolean)=>{state.calls.push(['review',alias,trust]);if(state.delayReview)await new Promise<void>(resolve=>state.release=resolve);return{reviewId:'review',path:'/chosen/project-notes',alias,trust};},cancelWorkspace:async(id:string)=>{state.calls.push(['cancel',id]);return{cancelled:true};},applyWorkspace:async(id:string,confirmed:boolean)=>{state.calls.push(['apply',id,confirmed]);if(state.uncertain)throw Error('Response lost');state.ready=true;state.items=[target];return{state:'completed'};},verify:async(alias:string)=>{state.calls.push(['verify',alias]);return{target:state.ready?target:null,detection:{launchReady:state.ready}};}}
  };
  (window as any).workspaceTest=state;(window as any).desktop=api;
  const appearance={read:async()=>({theme:'kemet',appearance:'light',density:'comfortable',language}),write:async()=>{}};
  createRoot(host).render(React.createElement(React.StrictMode,null,React.createElement(AppearanceProvider,{store:appearance},React.createElement(App,{adapter:{kind:'live',api,appearance}}))));
 },language);
 await expect(page.getByLabel(translate(language,'Draft guidance'))).toBeEditable();
}
const calls=(page:Page)=>page.evaluate(()=>(window as any).workspaceTest.calls);
async function review(page:Page){
 await page.getByRole('button',{name:'Work target',exact:true}).click();
 await page.getByRole('button',{name:'Add folder…',exact:true}).click();
 await expect(page.getByRole('button',{name:'Review workspace',exact:true})).toBeDisabled();
 await page.getByLabel('I trust this folder for agent execution. Approval rules still apply.').check();
 await page.getByRole('button',{name:'Review workspace',exact:true}).click();
 await expect(page.getByRole('button',{name:'Trust and use workspace',exact:true})).toBeVisible();
}
test('drafts are editable without a target, while submission and attachments remain gated',async({page})=>{
 await mount(page);await page.getByLabel('Draft guidance').fill('Keep my idea');await page.getByLabel('Draft guidance').press('Control+Enter');
 await expect(page.getByRole('button',{name:'Send prompt',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Add attachments',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'New chat',exact:true}).click();await expect(page.locator('.ec-workspacegroup summary').filter({hasText:'Drafts'})).toBeVisible();await expect(page.locator('.ec-workspacegroup summary').filter({hasText:'History'})).toBeVisible();
 await page.getByRole('button',{name:'Earlier conversation Completed'}).click();await expect(page.getByText('This conversation has no workspace attached. Start a new chat and choose a folder to continue working.')).toBeVisible();
 expect((await calls(page)).some((c:any)=>c[0]==='submit'||c[0]==='apply'||c[0]==='attach')).toBe(false);
});
test('folder review is explicit, cancellation is inert, successful registration preserves the draft',async({page})=>{
 await mount(page);await page.getByLabel('Draft guidance').fill('Keep my idea');await review(page);
 expect((await calls(page)).some((c:any)=>c[0]==='apply')).toBe(false);await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Work target',exact:true})).toBeFocused();expect(await calls(page)).toContainEqual(['cancel','review']);
 await review(page);await page.getByRole('button',{name:'Trust and use workspace',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByLabel('Draft guidance')).toHaveValue('Keep my idea');await expect(page.getByRole('button',{name:'Send prompt',exact:true})).toBeEnabled();
 expect(await calls(page)).toContainEqual(['review','project-notes',true]);expect(await calls(page)).toContainEqual(['apply','review',true]);
 await page.getByRole('button',{name:'Add attachments',exact:true}).click();await page.getByRole('button',{name:'Choose files…',exact:true}).click();await page.getByRole('button',{name:'Work target',exact:true}).click();await page.getByRole('searchbox',{name:'Find a workspace'}).fill('missing');await expect(page.getByText('No matching workspaces.')).toBeVisible();await page.getByRole('searchbox').fill('Project');await page.getByRole('dialog').getByRole('button',{name:/Project notes/}).click();await expect(page.getByLabel('Attachments',{exact:true})).toContainText('notes.md');
 await page.evaluate(()=>(window as any).workspaceTest.items.push({targetId:'other',targetGeneration:1,label:'Other folder',isolation:'host'}));await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('.ec-taskbutton').filter({hasText:'Keep my idea'}).click();await page.getByRole('button',{name:'Work target',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:/Other folder/}).click();await expect(page.getByLabel('Attachments',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Draft guidance')).toHaveValue('Keep my idea');
});
test('cancelled native picker and a late review after profile switch cannot attach a workspace',async({page})=>{
 await mount(page);await page.evaluate(()=>(window as any).workspaceTest.cancelPicker=true);await page.getByRole('button',{name:'Work target',exact:true}).click();await page.getByRole('button',{name:'Add folder…',exact:true}).click();await expect(page.getByText('No workspaces yet. Add a folder to get started.')).toBeVisible();await page.keyboard.press('Escape');
 await page.evaluate(()=>{const s=(window as any).workspaceTest;s.cancelPicker=false;s.delayReview=true;});
 await page.getByRole('button',{name:'Work target',exact:true}).click();await page.getByRole('button',{name:'Add folder…',exact:true}).click();await page.getByLabel('I trust this folder for agent execution. Approval rules still apply.').check();await page.getByRole('button',{name:'Review workspace',exact:true}).click();
 await page.evaluate(()=>(window as any).workspaceTest.refresh('other'));await expect(page.getByRole('dialog')).toHaveCount(0);await page.evaluate(()=>(window as any).workspaceTest.release());await expect.poll(()=>calls(page)).toContainEqual(['cancel','review']);expect((await calls(page)).some((c:any)=>c[0]==='apply')).toBe(false);await expect(page.getByRole('button',{name:'Send prompt',exact:true})).toBeDisabled();
});
test('lost apply response permits read-only reconciliation, never an automatic retry',async({page})=>{
 await mount(page);await page.getByLabel('Draft guidance').fill('Keep my idea');await review(page);await page.evaluate(()=>(window as any).workspaceTest.uncertain=true);await page.getByRole('button',{name:'Trust and use workspace',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Workspace not confirmed');await expect(page.getByRole('button',{name:'Trust and use workspace'})).toHaveCount(0);
 await page.getByRole('button',{name:'Check workspace',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
 await page.evaluate(()=>{const s=(window as any).workspaceTest;s.inspectionPath='/another/folder';s.ready=true;s.items=[{targetId:'target',targetGeneration:1,label:'Project notes',isolation:'host'}];});await page.getByRole('button',{name:'Check workspace',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.evaluate(()=>(window as any).workspaceTest.inspectionPath='/chosen/project-notes');await page.getByRole('button',{name:'Check workspace',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByLabel('Draft guidance')).toHaveValue('Keep my idea');expect((await calls(page)).filter((c:any)=>c[0]==='apply')).toHaveLength(1);
});
for(const language of ['en','ar'] as const)test(`${language} workspace flow fits narrow and desktop windows`,async({page},testInfo)=>{
 await mount(page,language);const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 for(const width of [360,1280]){await page.setViewportSize({width,height:800});await page.getByRole('button',{name:t('Work target'),exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeInViewport();expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await page.getByRole('button',{name:t('Add folder…'),exact:true}).click();await expect(page.getByRole('button',{name:t('Review workspace'),exact:true})).toBeDisabled();await expect(page.locator('.ec-folderpath bdi')).toHaveAttribute('dir','ltr');await page.screenshot({path:testInfo.outputPath(`workspace-${language}-${width}.png`)});await page.keyboard.press('Escape');}
 await page.screenshot({path:testInfo.outputPath(`composer-${language}.png`)});
});
