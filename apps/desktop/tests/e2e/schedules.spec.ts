import {test,expect} from '@playwright/test';
test('shows canonical schedule state and history without a fixture count or false running claim',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
 const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/schedules-view.tsx';const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{SchedulesView}=await import(cp);
 const job={id:'one',name:'Daily audit',objective:'Review repository changes',schedule:'every 1h',kind:'interval',status:'paused',delivery:'local',workspace:'/reviewed/workspace',model:null,nextRunAt:null,lastRunAt:null,lastStatus:null,runCount:0,runRequested:true,script:false,channelBound:false};
 const api={list:async()=>({items:[job],nextOffset:null}),get:async()=>job,history:async()=>({items:[{id:'run',workId:'session:owned',startedAt:'2026-09-13T10:00:00Z',completedAt:null,status:'failed',failure:'runtime_error',delivery:[]}],nextOffset:null,available:true})};
 const host=document.querySelector('.ec-window')!;host.innerHTML='<div id="schedules-test"></div>';createRoot(document.querySelector('#schedules-test')!).render(React.createElement(SchedulesView,{api,ready:true,select:(id:string)=>{(window as any).openedScheduleWork=id;}}));
 });
 await page.getByRole('button',{name:/Daily audit/}).click();await expect(page.getByText('Run requested; execution has not been confirmed.')).toBeVisible();await expect(page.getByText('runtime_error')).toBeVisible();await page.getByRole('button',{name:'Open source Work'}).click();expect(await page.evaluate(()=>(window as any).openedScheduleWork)).toBe('session:owned');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
