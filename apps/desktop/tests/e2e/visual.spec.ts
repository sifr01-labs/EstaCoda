import {test,expect,type Page} from '@playwright/test';
import{readFileSync,mkdirSync,writeFileSync}from'node:fs';import{resolve}from'node:path';import{createHash}from'node:crypto';import{platform,release}from'node:os';
const frozen=readFileSync(resolve('../../docs/planning/desktop-design/approved-prototype.html'),'utf8');
const hash=createHash('sha256').update(frozen).digest('hex');
const lucide=readFileSync('tests/reference/lucide-1.17.0.js','utf8');
const evidence=resolve('tests/visual-evidence');
const click=async(p:Page,name:string)=>{const button=p.getByRole('button',{name,exact:true});if(['Settings','Search chats'].includes(name)&&!await button.isVisible())await p.locator('.ec-sidebar-toggle').click();await button.click();};
const retry=async(p:Page)=>{if((p.viewportSize()?.width??1024)<590){await nav(p,'Inbox');await p.getByRole('button',{name:'Review request',exact:true}).click();}else await p.locator('.ec-taskbutton').filter({hasText:'Make billing retries resilient'}).first().click();};
const nav=async(p:Page,name:string)=>{if(!await p.locator('#ec-sidebar').isVisible())await p.locator('.ec-sidebar-toggle').click();await p.locator('.ec-navgroup').getByRole('button',{name:new RegExp('^'+name)}).click();};
const settings=async(p:Page,name:string)=>{await click(p,'Settings');await p.locator('.ec-settingslink').filter({hasText:name}).click();};
type Scenario={id:string;ref:Record<string,unknown>;act:(p:Page)=>Promise<unknown>;modal?:boolean};
const scenarios:Scenario[]=[
 {id:'V01-new-chat',ref:{},act:async()=>{}},
 {id:'V02-draft',ref:{draft:'Review مرحباً billing.ts'},act:p=>p.getByRole('textbox',{name:'Draft guidance',exact:true}).fill('Review مرحباً billing.ts')},
 {id:'V03-attachment-menu',ref:{attachMenu:true},act:p=>click(p,'Add attachments')},
 {id:'V03-attachment',ref:{attachments:[{name:'retry-notes.md',type:'text/markdown',size:2048}]},act:async p=>{await click(p,'Add attachments');await click(p,'Try a sample');}},
 {id:'V04-search',ref:{page:'search',search:'billing'},act:async p=>{await click(p,'Search chats');await p.getByRole('searchbox').fill('billing');}},
 {id:'V04-empty-search',ref:{page:'search',search:'zzzz'},act:async p=>{await click(p,'Search chats');await p.getByRole('searchbox').fill('zzzz');}},
 {id:'V05-empty-pins',ref:{pinned:[]},act:p=>p.getByRole('button',{name:'Unpin Review webhook security'}).click()},
 {id:'V06-approval',ref:{task:'retry'},act:retry},
 {id:'V07-running',ref:{task:'retry',phase:'running'},act:async p=>{await retry(p);await click(p,'Approve once');}},
 {id:'V07-completed',ref:{task:'retry',phase:'done'},act:async p=>{await retry(p);await click(p,'Approve once');await p.clock.runFor(2300);}},
 {id:'V08-stopping',ref:{task:'retry',phase:'stopping'},act:async p=>{await retry(p);await click(p,'Approve once');await click(p,'Stop');}},
 {id:'V08-cancelled',ref:{task:'retry',phase:'stopped'},act:async p=>{await retry(p);await click(p,'Approve once');await click(p,'Stop');await p.clock.runFor(1200);}},
 {id:'V09-rejected',ref:{task:'retry',phase:'denied'},act:async p=>{await retry(p);await click(p,'Reject');}},
 {id:'V09-partial',ref:{task:'logs'},act:p=>p.locator('.ec-taskbutton').filter({hasText:'Summarize deployment logs'}).click()},
 {id:'V10-changes',ref:{task:'retry',tab:'changes'},act:async p=>{await retry(p);await p.getByRole('tab',{name:'Changes'}).click();}},
 {id:'V10-results',ref:{task:'webhook',tab:'results'},act:async p=>{await p.locator('.ec-taskbutton').filter({hasText:'Review webhook security'}).first().click();await p.getByRole('tab',{name:'Results'}).click();}},
 {id:'V11-inspector',ref:{task:'retry',inspector:true},act:async p=>{await retry(p);await click(p,'Show inspector');}},
 {id:'V12-inbox',ref:{page:'inbox'},act:p=>nav(p,'Inbox')},
 {id:'V13-appearance',ref:{page:'appearance'},act:p=>settings(p,'Appearance')},
 {id:'V15-models',ref:{page:'models'},act:p=>settings(p,'Models & providers')},
 {id:'V15-configure',ref:{page:'models',setupStep:0},modal:true,act:async p=>{await settings(p,'Models & providers');await click(p,'Add provider');}},
 {id:'V15-review',ref:{page:'models',setupStep:1,staged:true},modal:true,act:async p=>{await settings(p,'Models & providers');await click(p,'Add provider');await click(p,'Use sample credential');await click(p,'Simulate verification');}},
 {id:'V15-ready',ref:{page:'models',setupStep:2,staged:true,added:true},modal:true,act:async p=>{await settings(p,'Models & providers');await click(p,'Add provider');await click(p,'Use sample credential');await click(p,'Simulate verification');await click(p,'Apply demo configuration');}},
 {id:'V16-artifacts',ref:{page:'library'},act:p=>nav(p,'Library')},
 {id:'V16-preview',ref:{page:'library',artifact:'review'},act:async p=>{await nav(p,'Library');await p.locator('.ec-libraryrow').filter({hasText:'webhook-review.md'}).click();}},
 {id:'V17-capability',ref:{page:'library',library:'skills',capability:'browser'},act:async p=>{await nav(p,'Library');await click(p,'Skills & tools');await p.locator('.ec-libraryrow').filter({hasText:'Browser automation'}).click();}},
 {id:'V18-connections',ref:{page:'connections',connection:'telegram'},act:async p=>{await nav(p,'Connections');await p.locator('.ec-libraryrow').filter({hasText:'Telegram'}).click();}},
 {id:'V19-background',ref:{page:'background',scheduleOpen:true},act:async p=>{await click(p,'1 scheduled');await p.locator('.ec-libraryrow').filter({hasText:'Daily workspace summary'}).click();}},
];
const cases=[...scenarios.flatMap(s=>['light','dark'].map(mode=>({s,width:1024,mode,theme:'kemet'}))),...scenarios.filter(s=>['V01-new-chat','V06-approval','V03-attachment','V11-inspector','V15-configure'].includes(s.id)).flatMap(s=>[736,360].flatMap(width=>['light','dark'].map(mode=>({s,width,mode,theme:'kemet'})))),...scenarios.filter(s=>['V01-new-chat','V06-approval'].includes(s.id)).flatMap(s=>['graphite','sand'].flatMap(theme=>['light','dark'].map(mode=>({s,width:1024,mode,theme}))))];
for(const {s,width,mode,theme}of cases)test(`${s.id}-${theme}-${mode}-${width}`,async({page,context,browser},info)=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:mode as 'light'|'dark'});await page.clock.install({time:new Date('2026-09-10T10:42:00Z')});await page.clock.pauseAt(new Date('2026-09-10T10:42:00Z'));
 await page.goto(`/fixture.html?theme=${theme}&mode=${mode}`);await expect(page.locator('#ec-branded-workspace')).toHaveAttribute('data-theme',theme);await s.act(page);await page.mouse.move(0,0);await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo(0,0);});
 await expect(page.locator('.ec-window')).toHaveScreenshot(`${s.id}-${theme}-${mode}-${width}.png`,{animations:'disabled'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 if(process.env.CAPTURE_REFERENCE==='1'){
  mkdirSync(evidence,{recursive:true});const id=info.title;await page.locator('.ec-window').screenshot({path:resolve(evidence,id+'-react.png')});
  const ref=await context.newPage();await ref.setViewportSize({width,height:900});await ref.emulateMedia({colorScheme:mode as 'light'|'dark'});
  const instrumented=frozen.replace(/\}\)\(\);\s*<\/script>/,`globalThis.referenceState=(patch,modal)=>{Object.assign(state,patch);render();if(modal)showModal();};})();</script>`);
  await ref.setContent(`<!doctype html><style>html,body{margin:0;min-width:0;background:#131313}*{animation:none!important;transition:none!important}</style><script>${lucide}</script>${instrumented}`);
  await ref.evaluate(({patch,modal})=>(globalThis as any).referenceState(patch,modal),{patch:{...s.ref,theme,mode},modal:s.modal});await ref.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo(0,0);});await ref.locator('.ec-window').screenshot({path:resolve(evidence,id+'-reference.png')});
  const geometry=async(p:Page)=>p.evaluate(()=>Object.fromEntries(['.ec-window','.ec-workcenter','.ec-newwelcome','.ec-wordmark','.ec-newwelcome p','.ec-workspacehint','.ec-tasklist','.ec-taskbutton','.ec-composer','.ec-composer textarea','.ec-drafthint','.ec-runtimebar','.ec-profile','.ec-workheading'].map(selector=>{const e=document.querySelector(selector);if(!e)return[selector,null];const b=e.getBoundingClientRect(),c=getComputedStyle(e);return[selector,{x:b.x,y:b.y,w:b.width,h:b.height,display:c.display,margin:c.margin,padding:c.padding,lineHeight:c.lineHeight}];})));
  writeFileSync(resolve(evidence,id+'-geometry.json'),JSON.stringify({reference:await geometry(ref),react:await geometry(page)},null,2));
  writeFileSync(resolve(evidence,'environment.json'),JSON.stringify({referenceSha256:hash,platform:platform(),os:release(),chromium:browser.version(),widths:[1024,736,360],height:900,deviceScaleFactor:1,fonts:'-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',clock:'2026-09-10T10:42:00Z',animations:'disabled',referenceLucide:'1.17.0',reactLucide:'1.45.0',harness:1},null,2));await ref.close();
 }
});
for(const mode of ['light','dark'] as const)test(`V01-brand-retina-${mode}`,async({browser},info)=>{
 const context=await browser.newContext({viewport:{width:1024,height:900},deviceScaleFactor:2,colorScheme:mode,reducedMotion:'reduce'});const page=await context.newPage();
 try{await page.goto(`http://127.0.0.1:5317/fixture.html?mode=${mode}`);await expect(page.locator('.ec-wordmark')).toBeVisible();await expect(page.locator('.ec-newwelcome')).toHaveScreenshot(`brand-retina-${mode}.png`);
 if(process.env.CAPTURE_REFERENCE==='1'){
  await page.locator('.ec-newwelcome').screenshot({path:resolve(evidence,info.title+'-react.png')});const ref=await context.newPage();await ref.setContent(`<!doctype html><style>html,body{margin:0;background:#131313}</style><script>${lucide}</script>${frozen}`);await ref.locator('.ec-newwelcome').screenshot({path:resolve(evidence,info.title+'-reference.png')});
 }
 }finally{await context.close();}
});
