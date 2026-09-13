import {test,expect} from '@playwright/test';
test('shows canonical schedule state and history without a fixture count or false running claim',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/schedules-view.tsx';const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{SchedulesView}=await import(cp);
 const job={id:'one',name:'Daily audit',objective:'Review repository changes',schedule:'every 1h',kind:'interval',status:'paused',delivery:'local',workspace:'/reviewed/workspace',model:null,nextRunAt:null,lastRunAt:null,lastStatus:null,runCount:0,runRequested:true,script:false,channelBound:false};
 const api={list:async()=>({items:[job],nextOffset:null}),get:async()=>job,history:async()=>({items:[{id:'run',workId:'session:owned',startedAt:'2026-09-13T10:00:00Z',completedAt:null,status:'failed',failure:'runtime_error',delivery:[]}],nextOffset:null,available:true})};
 const host=document.querySelector('.ec-window')!;host.innerHTML='<div id="schedules-test"></div>';createRoot(document.querySelector('#schedules-test')!).render(React.createElement(SchedulesView,{api,ready:true,select:(id:string)=>{(window as any).openedScheduleWork=id;}}));
 });
 await page.getByRole('button',{name:/Daily audit/}).click();await expect(page.getByText('Run requested; execution has not been confirmed.')).toBeVisible();await expect(page.getByText('Runtime failed')).toBeVisible();await page.getByRole('button',{name:'Open source Work'}).click();expect(await page.evaluate(()=>(window as any).openedScheduleWork)).toBe('session:owned');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('requires review and explicit confirmation before saving a schedule',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/schedule-editor.tsx';const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{ScheduleEditor}=await import(cp);
 const state={writes:0,cancels:0,closed:false};(window as any).scheduleState=state;
 const api={review:async(action:any)=>({reviewId:'review',action,profileId:'one',workspace:'/selected/workspace',nextRunAt:'2026-09-14T09:00:00Z',authority:'strict',spendUsd:1,model:'local/model',expiresAt:Date.now()+300000}),execute:async()=>{state.writes++;return{operationId:'op',action:'schedule',state:'completed'};},cancel:async()=>{state.cancels++;return{cancelled:true};},inspect:async()=>null};
 const host=document.querySelector('.ec-window')!;host.innerHTML='<div id="schedule-editor-test"></div>';createRoot(document.querySelector('#schedule-editor-test')!).render(React.createElement(ScheduleEditor,{api,work:{targets:async()=>({items:[{targetId:'target',targetGeneration:1,label:'Workspace',isolation:'host'}],truncated:false})},onClose:()=>{state.closed=true;},onSaved:()=>{state.closed=true;}}));
 });
 await page.getByLabel('Schedule name',{exact:true}).fill('Audit');await page.getByLabel('Objective',{exact:true}).fill('Review changes');await page.getByRole('combobox',{name:'Execution target',exact:true}).selectOption('target');await page.getByRole('button',{name:'Review schedule',exact:true}).click();expect(await page.evaluate(()=>(window as any).scheduleState.writes)).toBe(0);await expect(page.getByText('/selected/workspace',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Confirm schedule change',exact:true}).click();expect(await page.evaluate(()=>(window as any).scheduleState.writes)).toBe(1);
});
test('run now remains a reviewed request and can be cancelled without execution',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/schedule-actions.tsx';const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{ScheduleActions}=await import(cp);
 const state={writes:0,cancels:0};(window as any).scheduleState=state;
 const api={review:async(action:any)=>({reviewId:'review',action,definition:null,profileId:'one',workspace:'/workspace',nextRunAt:null,authority:'strict',spendUsd:1,model:'local/model',expiresAt:Date.now()+300000}),execute:async()=>{state.writes++;return{state:'completed'};},cancel:async()=>{state.cancels++;return{cancelled:true};}};
 const host=document.querySelector('.ec-window')!;host.innerHTML='<div id="schedule-actions-test"></div>';createRoot(document.querySelector('#schedule-actions-test')!).render(React.createElement(ScheduleActions,{api,job:{id:'one',status:'paused',runRequested:false},onChanged:()=>{}}));
 });
 await page.getByRole('button',{name:'Run now',exact:true}).click();await expect(page.getByText(/Queue one run/)).toBeVisible();expect(await page.evaluate(()=>(window as any).scheduleState.writes)).toBe(0);await page.getByRole('button',{name:'Cancel',exact:true}).click();expect(await page.evaluate(()=>(window as any).scheduleState.cancels)).toBe(1);await page.getByRole('button',{name:'Run now',exact:true}).click();await page.getByRole('button',{name:'Confirm schedule change',exact:true}).click();expect(await page.evaluate(()=>(window as any).scheduleState.writes)).toBe(1);
});
test('renders Arabic scheduling validation without backend error text',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/schedule-actions.tsx',lp='/src/renderer/i18n.tsx';const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{ScheduleActions}=await import(cp),{LanguageContext}=await import(lp);
 const host=document.querySelector('.ec-window')!;host.innerHTML='<div dir="rtl" id="arabic-schedule-test"></div>';createRoot(document.querySelector('#arabic-schedule-test')!).render(React.createElement(LanguageContext.Provider,{value:'ar'},React.createElement(ScheduleActions,{api:{review:async()=>{throw new Error('private backend error');}},job:{id:'one',status:'active',runRequested:false},onChanged:()=>{}})));
 });await page.getByRole('button',{name:'تشغيل الآن',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('إجراء الجدول غير متاح. حدّث العرض وراجعه مجددًا.');await expect(page.getByText('private backend error')).toHaveCount(0);
});
for(const language of ['en','ar'] as const)test(`${language}: clearing arguments removes them and explicit empty arguments survive review`,async({page})=>{
 const {arabic}=await import('../../src/shared/i18n/catalog.js');const t=(key:keyof typeof arabic)=>language==='en'?key:arabic[key];
 await page.goto('/fixture.html');await page.evaluate(async language=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/schedule-editor.tsx',lp='/src/renderer/i18n.tsx';const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{ScheduleEditor}=await import(cp),{LanguageContext}=await import(lp);
  const draft={name:'Audit',objective:'Report',schedule:'every 1h',target:{targetId:'target',targetGeneration:1},model:null,delivery:'local',skills:[],toolsets:null,contextFrom:[],repeat:null,script:'audit.sh',scriptArgs:['--verbose'],scriptTimeoutMs:null,noAgent:true};
  const api={draft:async()=>draft,review:async(action:any)=>{(window as any).reviewedArguments=action.draft.scriptArgs;return{reviewId:'r',action,profileId:'one',workspace:'/workspace',nextRunAt:null,authority:'strict',spendUsd:null,model:'none',expiresAt:Date.now()+300000};},cancel:async()=>({cancelled:true}),inspect:async()=>null};
  const host=document.querySelector('.ec-window')!;host.innerHTML='<div id="argument-test"></div>';const root=createRoot(document.querySelector('#argument-test')!);let generation=0;
  const render=()=>root.render(React.createElement(LanguageContext.Provider,{value:language},React.createElement(ScheduleEditor,{key:++generation,api,id:'existing',onClose:()=>{},onSaved:()=>{}})));(window as any).resetArguments=render;render();
 },language);
 for(const [text,expected] of [['',[]],['""',['']],['"line\\nbreak"\n"\\"literal\\""',['line\nbreak','"literal"']]] as [string,string[]][]){
  await page.getByText(t('Advanced schedule options'),{exact:true}).click();await page.getByRole('textbox',{name:t('Script arguments (one per line)'),exact:true}).fill(text);await page.getByRole('button',{name:t('Review schedule'),exact:true}).click();expect(await page.evaluate(()=>(window as any).reviewedArguments)).toEqual(expected);await page.evaluate(()=>(window as any).resetArguments());
 }
});
