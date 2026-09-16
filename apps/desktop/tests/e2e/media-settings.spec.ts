import {test,expect,type Page} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';

async function mount(page:Page,section:'vision'|'voice',language:'en'|'ar'='en'){
 await page.goto('/fixture.html?language='+language);
 await page.evaluate(async({section,language})=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/public-settings.tsx',lp='/src/renderer/i18n.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{PublicSettingsView}=await import(cp),{LanguageContext}=await import(lp);
  const values:Record<string,any>={'stt.provider':'local','stt.enabled':true,'stt.local.engine':'faster-whisper','stt.local.fasterWhisper.model':'base','stt.openai.model':'whisper-1','stt.openai.apiKeyEnv':'configured','stt.xai.language':null,'stt.xai.diarize':false,'stt.xai.diarization':false,'stt.xai.keyterms':[],'tts.provider':'openai','tts.enabled':true,'tts.openai.model':'gpt-4o-mini-tts','tts.openai.voice':'alloy','tts.openai.speed':1,'tts.openai.apiKeyEnv':'configured','tts.edge.voice':'en-US-AriaNeural','tts.edge.speed':1,'voice.autoTts':false,'voice.autoTtsMaxCharsPerReply':500,'voice.autoTtsMaxCharsPerHourPerChat':5000,'auxiliaryModels.vision.provider':'auto','auxiliaryModels.vision.id':null,'auxiliaryModels.vision.enabled':true,'auxiliaryModels.vision.apiKeyEnv':null,'auxiliaryModels.vision.baseUrl':null,'auxiliaryModels.vision.contextWindowTokens':null,'auxiliaryModels.vision.hostedProcessing':'allow-with-approval','imageGen.provider':'fal','imageGen.baseUrl':'https://fal.example','imageGen.apiKeyEnv':null,'imageGen.model':'flux','imageGen.fal.model':'flux','imageGen.fal.apiKeyEnv':null,'imageGen.openai.model':'gpt-image-2-medium','imageGen.openai.apiKeyEnv':null};
  const choices:Record<string,any[]>={'stt.provider':['local','openai','xai'],'tts.provider':['openai','edge'],'imageGen.provider':['fal','openai']};
  const fields=Object.keys(values).filter(id=>section==='vision'?(id.startsWith('imageGen.')||id.startsWith('auxiliaryModels.')):(!id.startsWith('imageGen.')&&!id.startsWith('auxiliaryModels.'))).map(id=>({id,path:id.split('.'),section,kind:id.endsWith('apiKeyEnv')?'secret':choices[id]?'choice':typeof values[id]==='boolean'?'boolean':typeof values[id]==='number'?'number':Array.isArray(values[id])?'strings':'text',...(choices[id]?{choices:choices[id]}:{})}));
  const state={writes:0,stages:[] as string[],reviewed:[] as any[],values,uncertain:false,cancels:0};(window as any).mediaState=state;
  const api={read:async(_s:string,offset=0)=>{const part=fields.slice(offset,offset+12),rows=part.map(f=>({fieldId:f.id,selectors:[],value:values[f.id]}));return {fields:part,values:rows.filter(c=>!c.fieldId.endsWith('apiKeyEnv')),truncated:offset+12<fields.length,...(offset+12<fields.length?{nextOffset:offset+12}:{}),media:{effective:rows,defaults:rows.map(c=>({...c,value:c.fieldId.endsWith('apiKeyEnv')?null:c.value})),...(offset===0?{analysis:{providerId:'kimi',modelId:'kimi-k3'},imageModels:[{providerId:'openai',id:'gpt-image-2-medium',label:'GPT Image 2 · Medium'},{providerId:'fal',id:'flux',label:'FLUX'}]}:{})}};},begin:async()=>({setupId:'media-setup'}),stage:async(_id:string,field:string)=>{state.stages.push(field);return{staged:true};},review:async(_id:string,changes:any[])=>{state.reviewed=changes;return{draftId:'media-review',changes,previous:changes.map(c=>({...c,value:values[c.fieldId]})),expiresInMs:300000};},apply:async()=>{state.writes++;for(const c of state.reviewed)values[c.fieldId]=c.value;return{operationId:'media-review',state:state.uncertain?'uncertain':'applied'};},cancel:async()=>{state.cancels++;return{cancelled:true};},inspect:async()=>({operationId:'media-review',state:'applied'}),verify:async()=>({state:'configured'}),dependencies:async()=>({items:[{id:'faster-whisper',state:'installed',version:'1',packages:['faster-whisper'],groups:[],estimatedMb:100}]}),inspectDependency:async()=>null};
  const modelsApi={models:async()=>({items:[{providerId:'kimi',id:'kimi-k3',label:'Kimi K3',runnable:true,credentialState:'present',role:'primary',catalog:{vision:true,tools:true,contextTokens:1048576,price:{inputPerMillion:3,outputPerMillion:15}}}],nextCursor:null}),providers:async()=>({items:[{id:'kimi',label:'Kimi',authMethods:['api_key'],state:'ready'}],nextCursor:null})};
  const host=document.querySelector('.ec-window')!;host.innerHTML='<div id="media-test"></div>';createRoot(document.querySelector('#media-test')!).render(React.createElement(LanguageContext.Provider,{value:language},React.createElement(PublicSettingsView,{api,modelsApi,initialSection:section})));
 },{section,language});
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
 await mount(page,'voice');await expect(page.getByText('Installation not checked',{exact:true})).toBeVisible();await expect(page.getByText('Pricing unavailable')).toHaveCount(0);
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
