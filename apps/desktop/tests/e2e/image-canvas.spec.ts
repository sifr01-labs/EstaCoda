import {test,expect,type Page} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';

async function mount(page:Page,options:{language?:'en'|'ar';appearance?:'light'|'dark';state?:'ready'|'running'|'failed'|'compare'|'edit-failed';delay?:boolean;integrity?:string}={}){
 await page.goto('/fixture.html');
 await page.evaluate(async options=>{
  const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const {CanonicalActivity}=await import('/src/renderer/components/canonical-activity.tsx'),{LanguageContext}=await import('/src/renderer/i18n.tsx');
  const branded=document.querySelector('#ec-branded-workspace') as HTMLElement;branded.style.colorScheme=options.appearance??'light';branded.dir=options.language==='ar'?'rtl':'ltr';
  const host=branded.querySelector('.ec-window') as HTMLElement;host.innerHTML='<main id="image-test" style="width:100%;max-width:800px;margin:0 auto;padding:24px"></main>';host.style.cssText='display:block;height:auto;min-height:900px';host.dataset.native='true';
  let seq=0;const base={workId:'session:s',profileId:'p',timestamp:Date.now()-3000,sequence:0};const row=(kind:string,extra:any)=>({...base,id:'i'+seq++,kind,...extra});
  const output=(id:string)=>row('artifact',{label:id+'.png',bytes:120,mimeType:'image/png',reference:{source:'session',ownerId:'s',artifactId:id}});
  const image=output('original'),edited=output('edited'),user=row('message',{role:'user',text:'Create an image of an engraved silver khanjar.'}),tool=row('tool',{name:'image.generate',state:'running',summary:'Tool started',callId:'generate'});
  const result=row('result',{status:'completed',evidence:{state:'verified',summary:'',artifactIds:[]},usage:{reportedTokens:null,cost:null}});
  const response=row('message',{role:'assistant',phase:'response',text:'Your image is ready.\n\n![Image](artifact://original)\n\nArtifacts:\n- artifact://original:original (image, 120 B) - Generated image'});
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const ctx=canvas.getContext('2d')!,gradient=ctx.createLinearGradient(0,0,640,480);gradient.addColorStop(0,'#244248');gradient.addColorStop(1,'#9dbdb4');ctx.fillStyle=gradient;ctx.fillRect(0,0,640,480);ctx.fillStyle='#e8dfc9';ctx.beginPath();ctx.arc(360,220,100,0,Math.PI*2);ctx.fill();const data=canvas.toDataURL('image/png').split(',')[1];
  const listeners=new Set<(s:any)=>void>();const state={items:[user,tool,{...tool,id:'done',state:'completed'},image,result,response],status:'completed',image,tool,user,result,edits:[] as any[],stops:0,retries:[] as string[],saves:[] as any[],opens:[] as any[],media:[] as any[],integrity:options.integrity??'verified',delay:options.delay??false,resolve:(_v?:any)=>{},rerender:()=>{},publish:(status:string,profileId='p')=>{for(const fn of listeners)fn({status,profile:{id:profileId}})}};
  if(options.state==='running'){state.items=[user,tool];state.status='running';}
  if(options.state==='failed')state.items=[user,tool,{...tool,id:'failure',state:'failed'}];
  if(options.state==='compare'||options.state==='edit-failed')state.items.push(row('message',{role:'user',text:'Edit this image with image.edit: artifact://original\n\nUse cooler lighting.'}),row('tool',{name:'image.edit',state:'completed',callId:'edit',summary:'Tool completed'}),edited,{...result,id:'second-result'});
  if(options.state==='edit-failed'){state.items=state.items.filter(item=>item!==edited&&item.id!=='second-result').map(item=>item.kind==='tool'&&item.name==='image.edit'?{...item,state:'failed'}:item);}
  const api={snapshot:async()=>({status:'ready',profile:{id:'p'}}),onSnapshot:(fn:any)=>{listeners.add(fn);return()=>listeners.delete(fn)},artifacts:{open:async(reference:any)=>{state.opens.push(reference);return {artifact:{reference,displayName:reference.artifactId+'.png',mimeType:'image/png',retention:'retained',bytes:120},integrity:state.integrity,text:null,truncated:false};},media:async(reference:any)=>{state.media.push(reference);if(state.delay)await new Promise(resolve=>state.resolve=resolve);return{mimeType:'image/png',data};},save:async(reference:any)=>{state.saves.push(reference);return{saved:true}}}};
  const root=createRoot(document.getElementById('image-test')!);state.rerender=()=>root.render(React.createElement(LanguageContext.Provider,{value:options.language??'en'},React.createElement(CanonicalActivity,{items:[...state.items],workStatus:state.status,api,results:()=>{},onImageEdit:(reference:any,instruction:string)=>{state.edits.push({reference,instruction});return true;},onStopImage:async()=>{state.stops++},onRetryImage:(text:string)=>{state.retries.push(text);return true;}})));
  (window as any).imageTest=state;state.rerender();
 },options);
}

test('automatically previews verified images, hides redundant artifact text, and saves the selected reference',async({page})=>{
 await mount(page);const image=page.locator('.ec-image-open img');await expect(image).toBeVisible();await expect(image).toHaveJSProperty('naturalWidth',640);
 await expect(page.locator('.ec-run-answer')).not.toContainText('artifact://');await expect(page.locator('.ec-run-files')).toHaveCount(0);await expect(page.getByText('Binary output. Text preview unavailable.')).toHaveCount(0);
 await page.getByRole('button',{name:'Save image',exact:true}).click();expect(await page.evaluate(()=>(window as any).imageTest.saves[0])).toEqual({source:'session',ownerId:'s',artifactId:'original'});
 await page.locator('.ec-image-expand').click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.ec-image-expand')).toBeFocused();
 await page.getByRole('textbox',{name:'Refine image'}).fill('More intricate engraving');await page.getByRole('button',{name:'Refine image',exact:true}).click();expect(await page.evaluate(()=>(window as any).imageTest.edits[0])).toEqual({reference:{source:'session',ownerId:'s',artifactId:'original'},instruction:'More intricate engraving'});
});

test('moves from real generation to the image without a second canvas and routes cancellation',async({page})=>{
 await mount(page,{state:'running'});await expect(page.locator('.ec-image-generating')).toBeVisible();await page.getByRole('button',{name:'Stop image generation'}).click();expect(await page.evaluate(()=>(window as any).imageTest.stops)).toBe(1);
 await page.evaluate(()=>{const s=(window as any).imageTest;s.items.push({...s.tool,id:'finished',state:'completed'},s.image,s.result);s.status='completed';s.rerender()});await expect(page.locator('.ec-image-canvas')).toHaveCount(1);await expect(page.locator('.ec-image-open img')).toBeVisible();await expect(page.locator('.ec-image-generating')).toHaveCount(0);
});

test('rejects unverified bytes and retries only the preview',async({page})=>{
 await mount(page,{integrity:'unavailable'});await expect(page.getByText('Image preview unavailable',{exact:true}).first()).toBeVisible();expect(await page.evaluate(()=>(window as any).imageTest.media.length)).toBe(0);await expect(page.getByRole('button',{name:'Save image',exact:true})).toBeDisabled();
 await page.evaluate(()=>(window as any).imageTest.integrity='verified');await page.getByRole('button',{name:'Retry preview'}).click();await expect(page.locator('.ec-image-open img')).toBeVisible();expect(await page.evaluate(()=>(window as any).imageTest.edits.length)).toBe(0);
});

test('discards late media, closes the viewer and revokes displayed images when profile scope changes',async({page})=>{
 await mount(page,{delay:true});await expect.poll(()=>page.evaluate(()=>(window as any).imageTest.media.length)).toBe(1);
 await page.evaluate(()=>{const s=(window as any).imageTest;s.publish('ready','other');s.resolve()});await expect(page.locator('.ec-image-open img')).toHaveCount(0);await expect(page.getByRole('button',{name:'Save image',exact:true})).toBeDisabled();
 await page.evaluate(()=>{const s=(window as any).imageTest;s.delay=false;s.publish('ready')});await expect(page.locator('.ec-image-open img')).toBeVisible();await page.locator('.ec-image-expand').click();await expect(page.getByRole('dialog')).toBeVisible();await page.evaluate(()=>(window as any).imageTest.publish('disconnected'));await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.ec-image-open img')).toHaveCount(0);
});

test('restores a source comparison from recorded edit messages and allows keyboard comparison',async({page})=>{
 await mount(page,{state:'compare'});const canvas=page.locator('.ec-image-canvas').last();await canvas.scrollIntoViewIfNeeded();await expect(canvas.locator('.ec-image-open img')).toBeVisible();await canvas.getByRole('button',{name:'Compare images'}).click();const slider=canvas.getByRole('slider',{name:'Compare reference and result'});await expect(slider).toBeEnabled();await slider.focus();await page.keyboard.press('ArrowRight');await expect(slider).toHaveValue('51');await expect(canvas.locator('.ec-image-split')).toHaveAttribute('style',/51%/);await canvas.getByRole('button',{name:'Reference image',exact:true}).click();await expect(canvas.getByRole('heading')).toHaveText('original.png');await expect(canvas.getByRole('slider')).toHaveCount(0);
});

for(const language of ['en','ar'] as const)for(const appearance of ['light','dark'] as const)test(`canvas ${language} ${appearance} adapts to desktop and narrow widths`,async({page},info)=>{
 await mount(page,{language,appearance});await expect(page.locator('.ec-image-open img')).toBeVisible();const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 await page.getByRole('button',{name:t('Image details'),exact:true}).click();await expect(page.locator('.ec-image-details')).toBeVisible();
 for(const width of [1024,360]){await page.setViewportSize({width,height:1100});expect(await page.locator('#image-test').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath(`canvas-${language}-${appearance}-${width}.png`)});}
});

for(const lostResponse of [false,true])test(`real composer submits image refinement once and preserves receipt recovery (${lostResponse?'lost response':'accepted'})`,async({page})=>{
 await mount(page);await page.evaluate(async lostResponse=>{
  const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const {WorkView}=await import('/src/renderer/components/work-view.tsx'),{emptyDraft}=await import('/src/renderer/app.tsx');
  const s=(window as any).imageTest;s.submissions=[];
  const target={targetId:'target',targetGeneration:3,label:'Workspace',isolation:'host'};
  const work={id:'session:s',canonicalId:'s',profileId:'p',kind:'session',title:'Image generation',status:'completed',target,actions:[{id:'sessions.send',enabled:true}],updatedAt:1};
  const canvas=document.createElement('canvas');canvas.width=canvas.height=8;const data=canvas.toDataURL('image/png').split(',')[1];
  const api={snapshot:async()=>({status:'ready',profile:{id:'p'}}),onSnapshot:()=>()=>{},activity:async()=>({items:s.items,nextCursor:null}),artifacts:{open:async(reference:any)=>({artifact:{reference,displayName:'original.png',mimeType:'image/png',bytes:120,retention:'retained'},integrity:'verified',text:null}),media:async()=>({mimeType:'image/png',data})},work:{children:async()=>({items:[],nextCursor:null}),targets:async()=>({items:[target],truncated:false}),live:async()=>({active:false,text:''}),inspect:async()=>null,submit:async(input:any)=>{s.submissions.push(input);if(lostResponse&&!input.inspectOnly)throw new Error('Response lost');return{workId:work.id,receipt:{method:'sessions.send',state:'accepted'}};}}};
  const adapter={kind:'live',api};
  function Harness(){const [draft,setDraft]=React.useState({...emptyDraft(),target,securityMode:'strict',modelSelection:{providerId:'test',modelId:'model'}});s.draft=draft;return React.createElement(WorkView,{adapter,work,draft,change:setDraft,pinned:false,togglePin:()=>{},models:()=>{},profile:'p',attention:[],view:{tab:'activity',inspector:false,activityExtent:100},changeView:()=>{},select:()=>{}})}
  const host=document.querySelector('.ec-window')!;host.innerHTML='<div id="live-image-test"></div>';createRoot(document.getElementById('live-image-test')!).render(React.createElement(React.StrictMode,null,React.createElement(Harness)));
 },lostResponse);
 const edit=page.getByRole('textbox',{name:'Refine image'});await expect(edit).toBeEditable();await page.getByRole('textbox',{name:'Draft guidance'}).fill('An unfinished draft');await expect(edit).toBeDisabled();await page.getByRole('textbox',{name:'Draft guidance'}).fill('');await expect(edit).toBeEditable();
 await edit.fill('Keep the engraving; cool the light.');await page.getByRole('button',{name:'Refine image',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).imageTest.submissions.length)).toBe(1);
 const sent=await page.evaluate(()=>(window as any).imageTest.submissions[0]);expect(sent).toMatchObject({workId:'session:s',target:{targetId:'target',targetGeneration:3},text:'Edit this image with image.edit: artifact://original\n\nKeep the engraving; cool the light.',securityMode:'strict',selection:{providerId:'test',modelId:'model'},attachmentIds:[]});
 if(lostResponse){await page.getByRole('button',{name:'Check status',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).imageTest.submissions.length)).toBe(2);const inspected=await page.evaluate(()=>(window as any).imageTest.submissions[1]);expect(inspected).toMatchObject({...sent,inspectOnly:true});}
});

for(const state of ['failed','edit-failed'] as const)test(`retries a ${state} request explicitly while preserving the source`,async({page})=>{
 await mount(page,{state});const canvas=page.locator('.ec-image-canvas').last();await canvas.scrollIntoViewIfNeeded();
 if(state==='edit-failed')await expect(canvas.locator('.ec-image-open img')).toBeVisible();
 await canvas.getByRole('button',{name:'Retry image request'}).click();
 expect(await page.evaluate(()=>(window as any).imageTest.retries)).toEqual([state==='failed'?'Create an image of an engraved silver khanjar.':'Edit this image with image.edit: artifact://original\n\nUse cooler lighting.']);
});
