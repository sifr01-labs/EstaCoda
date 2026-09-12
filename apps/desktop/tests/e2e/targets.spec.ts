import {test,expect,type Page} from '@playwright/test';
async function mount(page:Page){await page.goto('/fixture.html');await page.evaluate(async()=>{
 const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js',componentPath='/src/renderer/components/target-manager.tsx';
 const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default,{TargetManager}=await import(componentPath);
 const host=document.querySelector('#ec-branded-workspace .ec-window')!;(host as HTMLElement).style.minHeight='740px';host.innerHTML='<button id="opener">Manage workspaces</button><div id="target-test"></div>';
 const state={calls:[] as any[],dirty:false,borrowers:0,fail:false,disconnect:()=>{}};(window as any).desktop={onSnapshot:(listener:any)=>{state.disconnect=()=>listener({status:'disconnected'});return()=>{};}};let target={targetId:'source',targetGeneration:1,kind:'local',label:'payments-api',workingRoot:'/projects/payments-api',sourceRoot:'/projects/payments-api',status:'available',readiness:'ready',managed:false};
 let receipt:any=null;
 const api={list:async()=>{if(state.fail)throw new Error();return{items:[target],truncated:false};},inspect:async()=>({...target,dirty:target.managed?state.dirty:null,borrowers:state.borrowers,branch:target.managed?'estacoda/example':null,cleanup:target.managed?'retained':null}),review:async(source:any)=>{state.calls.push(['review']);return{reviewId:'review',operationId:'op',source,sourceRoot:target.sourceRoot,destination:'/state/profiles/p/worktrees/example',branch:'estacoda/example',baseCommit:'a'.repeat(40),expiresAt:Date.now()+300000};},cancel:async()=>{state.calls.push(['cancel']);return{cancelled:true};},create:async(_id:string,trust:boolean)=>{state.calls.push(['create',trust]);target={...target,targetId:'tree',kind:'git-worktree',workingRoot:'/state/profiles/p/worktrees/example',managed:true};receipt={operationId:'op',action:'create',state:'completed',target:{targetId:'tree',targetGeneration:1}};return receipt;},execute:async(action:string,ref:any)=>{state.calls.push([action]);target={...target,status:'archived',readiness:'archived',targetGeneration:ref.targetGeneration+1};receipt={operationId:'op',action,state:'completed',target:{targetId:target.targetId,targetGeneration:target.targetGeneration}};return receipt;},operation:async()=>receipt};
 const root=createRoot(document.querySelector('#target-test')!);const show=()=>root.render(React.createElement(React.StrictMode,null,React.createElement(TargetManager,{api,onSelect:(ref:any)=>state.calls.push(['select',ref]),close:()=>root.render(null)})));
 document.getElementById('opener')!.onclick=show;(window as any).targetTest=state;
 });await page.getByRole('button',{name:'Manage workspaces'}).click();await page.getByRole('button',{name:/payments-api.*Ready/}).click();}
test('reviews creation, requires trust and selects a new target without submitting Work',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'Create worktree…'}).click();await expect(page.getByRole('heading',{name:'Review new worktree'})).toBeVisible();await expect(page.getByRole('button',{name:'Create trusted worktree'})).toBeDisabled();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Create trusted worktree'}).click();await expect(page.getByText('Last Create: Completed')).toBeVisible();await page.getByRole('button',{name:'Use for new Work'}).click();expect(await page.evaluate(()=>(window as any).targetTest.calls)).toEqual([['review'],['create',true],['select',{targetId:'tree',targetGeneration:1}]]);await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Manage workspaces'})).toBeFocused();
});
test('Escape cancels a review and restores focus without creating a worktree',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'Create worktree…'}).click();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).targetTest.calls)).toEqual([['review'],['cancel']]);await expect(page.getByRole('button',{name:'Manage workspaces'})).toBeFocused();
});
test('requires archive confirmation and keeps dirty cleanup disabled',async({page})=>{
 await mount(page);await page.getByRole('button',{name:'Create worktree…'}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Create trusted worktree'}).click();await page.getByRole('button',{name:'Archive…'}).click();expect(await page.evaluate(()=>(window as any).targetTest.calls.some((row:any)=>row[0]==='archive'))).toBe(false);await page.evaluate(()=>(window as any).targetTest.dirty=true);await page.getByRole('button',{name:'Confirm archive'}).click();await expect(page.getByText('Changes present — cleanup blocked')).toBeVisible();await expect(page.getByRole('button',{name:'Remove worktree files…'})).toBeDisabled();
});
test('creation review fits narrow widths and contains keyboard focus',async({page})=>{
 await page.setViewportSize({width:360,height:800});await mount(page);await page.getByRole('button',{name:'Create worktree…'}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Create trusted worktree'}).focus();await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Close workspace targets'})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/ec-pr9-target-review-narrow.png'});
});

test('clears ready target details on disconnect',async({page})=>{
 await mount(page);await expect(page.getByRole('button',{name:'Create worktree…'})).toBeEnabled();await page.evaluate(()=>(window as any).targetTest.disconnect());await expect(page.getByText('Connection changed. Refresh targets before continuing.')).toBeVisible();await expect(page.getByRole('button',{name:'Create worktree…'})).toHaveCount(0);await expect(page.getByRole('button',{name:/payments-api.*Ready/})).toHaveCount(0);
});

test('pages targets and inspects a newly created target outside the visible page',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
  const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js',componentPath='/src/renderer/components/target-manager.tsx';
  const React=(await import(reactPath)).default,{createRoot}=(await import(domPath)).default,{TargetManager}=await import(componentPath);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;(host as HTMLElement).style.minHeight='740px';host.innerHTML='<div id="target-test"></div>';
  const source={targetId:'source',targetGeneration:1,kind:'local',label:'First repository',workingRoot:'/first',sourceRoot:'/first',status:'available',readiness:'ready',managed:false};
  const second={...source,targetId:'second',label:'Later repository',workingRoot:'/later',sourceRoot:'/later'};
  const created={...source,targetId:'created',kind:'git-worktree',label:'New worktree',workingRoot:'/new',managed:true};
  const api={list:async(cursor?:string)=>({items:cursor?[second]:[source],truncated:!cursor,...(!cursor?{nextCursor:'next'}:{})}),inspect:async(ref:any)=>({...([source,second,created].find(row=>row.targetId===ref.targetId)!),dirty:false,borrowers:0,branch:null,cleanup:'retained'}),operation:async()=>null,review:async(ref:any)=>({reviewId:'review',source:ref,sourceRoot:'/first',destination:'/new',branch:'estacoda/new',baseCommit:'a'.repeat(40),expiresAt:Date.now()+300000}),create:async()=>({operationId:'op',action:'create',state:'completed',target:{targetId:'created',targetGeneration:1}}),cancel:async()=>({cancelled:true})};
  const root=createRoot(document.querySelector('#target-test')!);root.render(React.createElement(TargetManager,{api,onSelect:(ref:any)=>{(window as any).pickedTarget=ref;},close:()=>root.render(null)}));
 });
 await page.getByRole('button',{name:'Next targets'}).click();await expect(page.getByRole('button',{name:/Later repository/})).toBeVisible();
 await page.getByRole('button',{name:'First page'}).click();await page.getByRole('button',{name:/First repository/}).click();
 await page.getByRole('button',{name:'Create worktree…'}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Create trusted worktree'}).click();
 await expect(page.getByText('/new',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Use for new Work'}).click();
 expect(await page.evaluate(()=>(window as any).pickedTarget)).toEqual({targetId:'created',targetGeneration:1});
});
