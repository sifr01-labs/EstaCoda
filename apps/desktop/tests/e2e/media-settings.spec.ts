import {test,expect,type Page} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';

async function mount(page:Page,section:'vision'|'voice',language:'en'|'ar'='en',dependency:'installed'|'missing'|'error'|'pending'='installed'){
 await page.goto('/fixture.html?language='+language);
 await page.evaluate(async({section,language,dependency})=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/public-settings.tsx',lp='/src/renderer/i18n.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{PublicSettingsView}=await import(cp),{LanguageContext}=await import(lp);
  const values:Record<string,any>={'stt.provider':'local','stt.enabled':true,'stt.local.engine':'faster-whisper','stt.local.fasterWhisper.model':'base','stt.openai.model':'whisper-1','stt.openai.apiKeyEnv':'configured','stt.xai.language':null,'stt.xai.diarize':false,'stt.xai.diarization':false,'stt.xai.keyterms':[],'tts.provider':'openai','tts.enabled':true,'tts.openai.model':'gpt-4o-mini-tts','tts.openai.voice':'alloy','tts.openai.speed':1,'tts.openai.apiKeyEnv':'configured','tts.edge.voice':'en-US-AriaNeural','tts.edge.speed':1,'voice.autoTts':false,'voice.autoTtsMaxCharsPerReply':500,'voice.autoTtsMaxCharsPerHourPerChat':5000,'auxiliaryModels.vision.provider':'auto','auxiliaryModels.vision.id':null,'auxiliaryModels.vision.enabled':true,'auxiliaryModels.vision.apiKeyEnv':null,'auxiliaryModels.vision.baseUrl':null,'auxiliaryModels.vision.contextWindowTokens':null,'auxiliaryModels.vision.hostedProcessing':'allow-with-approval','imageGen.provider':'fal','imageGen.baseUrl':'https://fal.example','imageGen.apiKeyEnv':null,'imageGen.model':'flux','imageGen.fal.model':'flux','imageGen.fal.apiKeyEnv':null,'imageGen.openai.model':'gpt-image-2-medium','imageGen.openai.apiKeyEnv':null};
  const choices:Record<string,any[]>={'stt.provider':['local','openai','xai'],'tts.provider':['openai','edge'],'imageGen.provider':['fal','openai']};
  const fields=Object.keys(values).filter(id=>section==='vision'?(id.startsWith('imageGen.')||id.startsWith('auxiliaryModels.')):(!id.startsWith('imageGen.')&&!id.startsWith('auxiliaryModels.'))).map(id=>({id,path:id.split('.'),section,kind:id.endsWith('apiKeyEnv')?'secret':choices[id]?'choice':typeof values[id]==='boolean'?'boolean':typeof values[id]==='number'?'number':Array.isArray(values[id])?'strings':'text',...(choices[id]?{choices:choices[id]}:{})}));
  const state={writes:0,stages:[] as string[],reviewed:[] as any[],values,uncertain:false,cancels:0,dependencyReads:0,dependencyFailure:dependency==='error',dependencyInstalled:dependency==='installed',dependencyReceipt:dependency==='pending'?{operationId:'install-1',action:'dependency.install:faster-whisper:abc',state:'uncertain'}:null as any,installs:[] as any[],installThrows:false,waitRead:false,waitingRead:false,releaseRead:null as any};(window as any).mediaState=state;
  const api={read:async(_s:string,offset=0)=>{const part=fields.slice(offset,offset+12),rows=part.map(f=>({fieldId:f.id,selectors:[],value:values[f.id]}));return {fields:part,values:rows.filter(c=>!c.fieldId.endsWith('apiKeyEnv')),truncated:offset+12<fields.length,...(offset+12<fields.length?{nextOffset:offset+12}:{}),media:{effective:rows,defaults:rows.map(c=>({...c,value:c.fieldId.endsWith('apiKeyEnv')?null:c.value})),...(offset===0?{analysis:{providerId:'kimi',modelId:'kimi-k3'},imageModels:[{providerId:'openai',id:'gpt-image-2-medium',label:'GPT Image 2 · Medium'},{providerId:'fal',id:'flux',label:'FLUX'}]}:{})}};},begin:async()=>({setupId:'media-setup'}),stage:async(_id:string,field:string)=>{state.stages.push(field);return{staged:true};},review:async(_id:string,changes:any[])=>{state.reviewed=changes;return{draftId:'media-review',changes,previous:changes.map(c=>({...c,value:values[c.fieldId]})),expiresInMs:300000};},apply:async()=>{state.writes++;for(const c of state.reviewed)values[c.fieldId]=c.value;return{operationId:'media-review',state:state.uncertain?'uncertain':'applied'};},cancel:async()=>{state.cancels++;return{cancelled:true};},inspect:async()=>({operationId:'media-review',state:'applied'}),verify:async()=>({state:'configured'}),dependencies:async()=>{state.dependencyReads++;if(state.waitRead){state.waitingRead=true;await new Promise(resolve=>state.releaseRead=resolve);}if(state.dependencyFailure)throw Error('Unavailable');return{items:['faster-whisper','edge-tts'].map(id=>({id,state:state.dependencyInstalled?'installed':'install_required',version:'1',packages:[id],groups:[],estimatedMb:id==='faster-whisper'?200:20}))};},inspectDependency:async()=>state.dependencyReceipt,install:async(id:string,groups:string[],approved:boolean)=>{state.installs.push({id,groups,approved});state.dependencyReceipt={operationId:'install-1',action:'dependency.install:'+id+':abc',state:'uncertain'};if(state.installThrows)throw Error('Response lost');return state.dependencyReceipt;}};
  const modelsApi={models:async()=>({items:[{providerId:'kimi',id:'kimi-k3',label:'Kimi K3',runnable:true,credentialState:'present',role:'primary',catalog:{vision:true,tools:true,contextTokens:1048576,price:{inputPerMillion:3,outputPerMillion:15}}}],nextCursor:null}),providers:async()=>({items:[{id:'kimi',label:'Kimi',authMethods:['api_key'],state:'ready'}],nextCursor:null})};
  const host=document.querySelector('.ec-window')!;host.innerHTML='<div id="media-test"></div>';const mediaRoot=createRoot(document.querySelector('#media-test')!);(window as any).mediaUnmount=()=>mediaRoot.unmount();mediaRoot.render(React.createElement(LanguageContext.Provider,{value:language},React.createElement(PublicSettingsView,{api,modelsApi,initialSection:section})));
 },{section,language,dependency});
 await expect(page.locator('.ec-media-section').first()).toBeVisible();
}

test('image setup stages credentials and reviews the selected provider without writing early',async({page})=>{
 await mount(page,'vision');await expect(page.getByText('Currently resolves to', {exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Set up',exact:true}).click();await page.getByRole('button',{name:/OpenAI.*GPT Image 2/}).click();
 await expect(page.getByRole('button',{name:'Use model',exact:true})).toBeDisabled();await page.locator('[id="setting-imageGen.openai.apiKeyEnv"]').click();
 await expect.poll(()=>page.evaluate(()=>(window as any).mediaState.stages)).toEqual(['imageGen.openai.apiKeyEnv']);
 await page.getByRole('button',{name:'Use model',exact:true}).click();await page.getByRole('button',{name:'Review changes',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).mediaState.writes)).toBe(0);
 const reviewed=await page.evaluate(()=>(window as any).mediaState.reviewed);expect(reviewed).toContainEqual({fieldId:'imageGen.baseUrl',selectors:[],value:null});expect(reviewed).toContainEqual({fieldId:'imageGen.apiKeyEnv',selectors:[],value:null});expect(reviewed).toContainEqual({fieldId:'imageGen.provider',selectors:[],value:'openai'});expect(reviewed).toContainEqual({fieldId:'imageGen.model',selectors:[],value:null});expect(reviewed).toContainEqual({fieldId:'imageGen.openai.model',selectors:[],value:'gpt-image-2-medium'});
 await page.getByRole('button',{name:'Back',exact:true}).click();await expect(page.getByText('Re-enter protected credentials after editing a review.')).toBeVisible();expect(await page.evaluate(()=>(window as any).mediaState.cancels)).toBe(1);
 await page.getByRole('button',{name:'Discard changes',exact:true}).click();expect(await page.evaluate(()=>(window as any).mediaState.writes)).toBe(0);await expect(page.getByText('Not configured',{exact:true})).toBeVisible();
});

test('voice changes remain independent and hide inactive provider settings',async({page})=>{
 await mount(page,'voice');await expect(page.locator('.ec-media-section').first().getByText('Installed',{exact:true})).toBeVisible();await expect(page.getByText('Pricing unavailable')).toHaveCount(0);
 await page.getByRole('button',{name:/Alloy/}).click();await page.getByRole('button',{name:'Nova',exact:true}).click();await page.getByRole('button',{name:'Use this voice'}).click();
 await page.getByRole('slider',{name:'Speaking speed'}).fill('1.4');await page.getByRole('checkbox',{name:'Send voice replies'}).check();
 await page.getByText('Advanced & diagnostics',{exact:true}).click();await page.getByText('Transcription options',{exact:true}).click();await expect(page.getByText('Identify speakers',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Review changes',exact:true}).click();const rows=await page.evaluate(()=>(window as any).mediaState.reviewed);expect(rows.map((c:any)=>c.fieldId).sort()).toEqual(['tts.openai.speed','tts.openai.voice','voice.autoTts']);await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).mediaState.writes)).toBe(1);
});

for(const section of ['vision','voice'] as const)for(const language of ['en','ar'] as const)test(`media design ${section} ${language}`,async({page})=>{
 await mount(page,section,language);await expect(page.locator('.ec-media-page')).toHaveScreenshot(`media-${section}-${language}.png`);
 await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>{document.querySelector<HTMLElement>('#ec-branded-workspace')!.dataset.appearance='dark';});
 await expect(page.locator('.ec-media-page')).toHaveScreenshot(`media-${section}-${language}-dark.png`);
 await page.setViewportSize({width:390,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expect(page.getByRole('button',{name:translate(language,'Change'),exact:true}).first()).toBeVisible();
});

for(const language of ['en','ar'] as const)test(`voice installation is explicit, independent, and reconciles without replay ${language}`,async({page})=>{
 const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 await mount(page,'voice',language,'missing');
 await expect.poll(()=>page.evaluate(()=>(window as any).mediaState.dependencyReads)).toBeGreaterThan(0);
 await expect(page.locator('.ec-media-section').first().getByText(t('Setup required'),{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).mediaState.installs)).toEqual([]);
 await page.getByRole('button',{name:t('Install…'),exact:true}).click();
 await expect(page.getByRole('region',{name:t('Voice setup')})).toBeVisible();
 await expect(page.locator('.ec-voice-install h3')).toBeFocused();
 await page.getByRole('button',{name:t('Cancel'),exact:true}).click();
 await expect(page.getByRole('button',{name:t('Install…'),exact:true})).toBeFocused();
 expect(await page.evaluate(()=>(window as any).mediaState.installs)).toEqual([]);
 await page.getByRole('checkbox',{name:t('Send voice replies')}).check();
 await page.getByRole('button',{name:t('Install…'),exact:true}).click();
 await expect(page.locator('.ec-voice-install')).toHaveScreenshot(`voice-install-review-${language}.png`);
 await page.locator('.ec-media-section').first().screenshot({path:`/tmp/voice-install-card-${language}.png`});
 await page.setViewportSize({width:390,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.setViewportSize({width:1024,height:900});
 await page.getByRole('button',{name:t('Download and install'),exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
 await expect(page.getByText(t('Installation may still be running. Checking its status will not start another download.'))).toBeVisible();
 await page.getByRole('region',{name:t('Voice setup')}).getByRole('button',{name:t('Check status'),exact:true}).click();
 expect(await page.evaluate(()=>(window as any).mediaState.installs)).toEqual([{id:'faster-whisper',groups:[],approved:true}]);
 expect(await page.evaluate(()=>(window as any).mediaState.writes)).toBe(0);
 await page.evaluate(()=>{const state=(window as any).mediaState;state.dependencyInstalled=true;state.dependencyReceipt.state='completed';});
 await expect(page.locator('.ec-media-section').first().getByText(t('Installed'),{exact:true})).toBeVisible();
 await page.getByRole('button',{name:t('Done'),exact:true}).click();
 await expect(page.getByRole('button',{name:t('Review changes'),exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).mediaState.installs.length)).toBe(1);
});
test('automatic dependency failures are actionable and never trigger downloads',async({page})=>{
 await mount(page,'voice','en','error');await expect(page.getByText('Couldn’t check installation',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Install…',exact:true})).toHaveCount(0);
 await page.evaluate(()=>(window as any).mediaState.dependencyFailure=false);
 await page.getByRole('button',{name:'Check again',exact:true}).first().click();
 await expect(page.getByRole('button',{name:'Install…',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).mediaState.installs)).toEqual([]);
});
test('reopening an unresolved installation blocks another download',async({page})=>{
 await mount(page,'voice','en','pending');await expect(page.locator('.ec-media-section').first().getByText('Confirming installation…',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Install…',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Check status',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).mediaState.installs)).toEqual([]);
});
test('lost installation acknowledgment is inspected without replay',async({page})=>{
 await mount(page,'voice','en','missing');await page.evaluate(()=>(window as any).mediaState.installThrows=true);
 await page.getByRole('button',{name:'Install…',exact:true}).click();await page.getByRole('button',{name:'Download and install',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).mediaState.installs.length)).toBe(1);
 await expect(page.getByRole('button',{name:'Download and install',exact:true})).toHaveCount(0);
 await page.getByRole('region',{name:'Voice setup'}).getByRole('button',{name:'Check status',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).mediaState.installs.length)).toBe(1);
});

test('leaving during the final read-only check cannot start an installation',async({page})=>{
 await mount(page,'voice','en','missing');await page.getByRole('button',{name:'Install…',exact:true}).click();
 await page.evaluate(()=>(window as any).mediaState.waitRead=true);
 await page.getByRole('button',{name:'Download and install',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).mediaState.waitingRead)).toBe(true);
 await page.evaluate(async()=>{(window as any).mediaUnmount();(window as any).mediaState.releaseRead();await new Promise(requestAnimationFrame);});
 expect(await page.evaluate(()=>(window as any).mediaState.installs)).toEqual([]);
});
test('Edge setup installs only its registered software and does not save the selected voice',async({page})=>{
 await mount(page,'voice','en','missing');await page.locator('.ec-media-section').nth(1).getByRole('button',{name:'Change',exact:true}).click();
 await page.getByRole('button',{name:/Edge speech/}).click();await page.getByRole('button',{name:'Use engine',exact:true}).click();
 await page.locator('.ec-media-section').nth(1).getByRole('button',{name:'Install…',exact:true}).click();
 await page.getByRole('button',{name:'Download and install',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).mediaState.installs)).toEqual([{id:'edge-tts',groups:[],approved:true}]);
 expect(await page.evaluate(()=>(window as any).mediaState.writes)).toBe(0);
});
