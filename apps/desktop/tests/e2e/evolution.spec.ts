import {test,expect} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';
for(const language of ['en','ar'] as const)test('Evolution requires review and confirmation '+language,async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async language=>{
  const react='/node_modules/.vite/deps/react.js',dom='/node_modules/.vite/deps/react-dom_client.js',component='/src/renderer/components/evolution-controls.tsx',context='/src/renderer/i18n.tsx';
  const React=(await import(react)).default,{createRoot}=(await import(dom)).default,{EvolutionControls}=await import(component),{LanguageContext}=await import(context);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<div id="evolution-test"></div>';
  const state={executions:0,cancellations:0};const detail={proposal:{id:'p',status:'proposed'},manifest:null};
  const api={evolution:{review:async({action}:any)=>({reviewId:'r',proposalId:'p',action,diff:'Reviewed patch',commands:[],workspace:null,allowed:true,reason:'ready'}),cancel:async()=>{state.cancellations++;return{cancelled:true};},execute:async()=>{state.executions++;return{operationId:'op',action:'evolution',state:'completed'};}}};
  createRoot(document.querySelector('#evolution-test')!).render(React.createElement(LanguageContext.Provider,{value:language},React.createElement(EvolutionControls,{api,detail,changed:()=>{}})));(window as any).evolutionTest=state;
 },language);const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 await page.getByRole('button',{name:t('Approve proposal'),exact:true}).click();await expect(page.getByText('Reviewed patch')).toBeVisible();expect(await page.evaluate(()=>(window as any).evolutionTest.executions)).toBe(0);
 await page.getByRole('button',{name:t('Cancel'),exact:true}).click();expect(await page.evaluate(()=>(window as any).evolutionTest.cancellations)).toBe(1);
 await page.getByRole('button',{name:t('Promote proposal'),exact:true}).click();await page.getByRole('button',{name:t('Confirm proposal decision')}).click();expect(await page.evaluate(()=>(window as any).evolutionTest.executions)).toBe(1);
});
