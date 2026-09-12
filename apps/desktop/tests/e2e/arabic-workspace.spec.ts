import {test,expect} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';
for(const kind of ['files','diff','evidence','terminal'] as const)test(`Arabic workspace ${kind} retains data and authority boundaries`,async({page})=>{
 await page.goto('/fixture.html?language=ar');await page.evaluate(async kind=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',lp='/src/renderer/i18n.tsx';const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{LanguageContext}=await import(lp);
  const paths={files:['file-browser','FileBrowser'],diff:['changes-view','ChangesView'],evidence:['evidence-view','EvidenceView'],terminal:['terminal-view','TerminalView']};const [file,name]=paths[kind],path='/src/renderer/components/'+file+'.tsx',Component=(await import(path))[name!];
  const host=document.querySelector('.ec-window')!;host.innerHTML='<div class="ec-page" id="surface"></div>';const state={opens:0,writes:[] as string[],disconnect:()=>{}};(window as any).arabicSurface=state;
  const api={onSnapshot:(listener:any)=>{state.disconnect=()=>listener({status:'disconnected'});return()=>{};},
   files:{list:async()=>({items:[{name:'app.ts',path:'app.ts',kind:'file'},{name:'link',path:'link',kind:'symlink'}],truncated:false}),preview:async()=>({path:'app.ts',size:32,binary:false,text:'<script>unchanged العربية</script>',truncated:false})},
   diff:{list:async()=>({items:[{path:'app.ts',previousPath:null,stage:'staged',status:'modified',previewable:true}],truncated:false}),patch:async()=>({path:'app.ts',stage:'staged',binary:false,text:'-old\n+new العربية',truncated:false})},
   evidence:{get:async()=>({workId:'session:s',state:'unverified',completion:'partial',summary:'English legacy explanation',summaryCode:'unverified',limitationCodes:['mutation_unverified'],limitations:['English legacy limitation'],facts:[{callId:'write',tool:'file.write',kind:'unverified_mutation',verifiedBy:null}],artifacts:[],truncated:false})},
   terminal:{open:async()=>{state.opens++;return{id:'handle',backend:'host'};},read:async()=>({data:'',state:'running',truncated:false,more:false}),write:async(_id:string,data:string)=>{state.writes.push(data);},resize:async()=>{},close:async()=>{}}};
  const root=createRoot(document.querySelector('#surface')!);root.render(React.createElement(LanguageContext.Provider,{value:'ar'},React.createElement(Component,{api,target:{targetId:'t',targetGeneration:1},work:{id:'session:s',profileId:'p'},close:()=>root.render(null)})));
 },kind);
 const t=(key:Parameters<typeof translate>[1])=>translate('ar',key);
 if(kind==='files'){await page.getByRole('button',{name:'app.ts',exact:true}).click();await expect(page.getByText('<script>unchanged العربية</script>',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/link/})).toBeDisabled();expect(await page.locator('pre').evaluate(e=>getComputedStyle(e).direction)).toBe('ltr');}
 if(kind==='diff'){await page.getByRole('button',{name:/app.ts/}).click();await expect(page.getByText('+new العربية',{exact:true})).toBeVisible();await expect(page.getByText(t('Modified'),{exact:false})).toBeVisible();}
 if(kind==='evidence'){await expect(page.getByText(t('Completion has not been verified by recorded executions.'),{exact:true})).toBeVisible();await expect(page.getByText(t('Observed mutations lack compatible validation.'),{exact:true})).toBeVisible();await expect(page.locator('body')).not.toContainText('English legacy');}
 if(kind==='terminal'){expect(await page.evaluate(()=>(window as any).arabicSurface.opens)).toBe(0);await page.getByRole('button',{name:t('Open terminal'),exact:true}).click();await expect(page.locator('.xterm')).toBeVisible();expect(await page.locator('.xterm').evaluate(e=>getComputedStyle(e).direction)).toBe('ltr');await page.locator('.xterm-helper-textarea').press('a');await expect.poll(()=>page.evaluate(()=>(window as any).arabicSurface.writes.join(''))).toContain('a');}
 const tree=await page.locator('body').ariaSnapshot();expect(tree).not.toContain('الرسالة غير متاحة.');await page.evaluate(()=>(window as any).arabicSurface.disconnect());
});
