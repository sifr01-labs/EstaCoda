import {test,expect,type Page} from '@playwright/test';
import {translate} from '../../src/shared/i18n/index.js';
const code='  const label = "العربية <tag> & value";\n\n\treturn label;\n';
async function mount(page:Page,language:'en'|'ar'='en',native=true){
 await page.goto(`/fixture.html?language=${language}`);
 await page.evaluate(async({language,native,code})=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',lp='/src/renderer/i18n.tsx',cp='/src/renderer/components/response-markdown.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{LanguageContext}=await import(lp),{ResponseMarkdown}=await import(cp);
  const host=document.querySelector('.ec-window')!;host.innerHTML='<main id="copy-test" style="padding:24px;max-width:800px;width:100%;box-sizing:border-box"></main>';
  const state={writes:[] as string[],browserCalls:0,reject:false};(window as any).copyTest=state;
  (window as any).desktop=native?{clipboard:{writeText:async(text:string)=>{if(state.reject)throw Error('private clipboard error');state.writes.push(text);}}}:undefined;
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{state.browserCalls++;if(native)throw Error('Browser clipboard denied');state.writes.push(text);}}});
  createRoot(document.querySelector('#copy-test')!).render(React.createElement(LanguageContext.Provider,{value:language},React.createElement(ResponseMarkdown,{text:'```ts\n'+code+'```\n\n[Reference](https://example.com/docs?q=one&lang=ar)'})));
 },{language,native,code});
}
for(const language of ['en','ar'] as const)test(`code and links use the native write bridge when browser copying is denied ${language}`,async({page})=>{
 await mount(page,language);const t=(key:Parameters<typeof translate>[1])=>translate(language,key);
 const button=page.getByRole('button',{name:t('Copy code'),exact:true});await expect(button).toHaveText('');await button.focus();await button.press('Enter');
 await expect(button).toHaveAttribute('title',t('Copied'));expect(await page.evaluate(()=>(window as any).copyTest.writes)).toEqual([code]);
 await expect(button).toHaveAttribute('title',t('Copy code'));
 await page.getByRole('button',{name:t('Copy link'),exact:true}).click();await expect(page.getByRole('button',{name:t('Copy link'),exact:true})).toHaveText('Reference');
 expect(await page.evaluate(()=>(window as any).copyTest.writes)).toEqual([code,'https://example.com/docs?q=one&lang=ar']);expect(await page.evaluate(()=>(window as any).copyTest.browserCalls)).toBe(0);
 await page.setViewportSize({width:360,height:700});expect(await page.locator('#copy-test').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.screenshot({path:`/private/tmp/estacoda-copy-${language}.png`});
});
test('native failures report failure and allow retry without bypassing the bridge',async({page})=>{
 await mount(page);await page.evaluate(()=>(window as any).copyTest.reject=true);const button=page.getByRole('button',{name:'Copy code',exact:true});await button.click();await expect(page.getByRole('status').first()).toHaveText('Copy unavailable');
 expect(await page.evaluate(()=>(window as any).copyTest.browserCalls)).toBe(0);await expect(page.locator('body')).not.toContainText('private clipboard error');
 await page.evaluate(()=>(window as any).copyTest.reject=false);await button.click();await expect(button).toHaveAttribute('title','Copied');expect(await page.evaluate(()=>(window as any).copyTest.writes)).toEqual([code]);
});
test('browser fixture fallback works and missing clipboard is handled',async({page})=>{
 await mount(page,'en',false);const button=page.getByRole('button',{name:'Copy code',exact:true});await button.click();await expect(button).toHaveAttribute('title','Copied');expect(await page.evaluate(()=>(window as any).copyTest.writes)).toEqual([code]);
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:undefined}));await button.click();await expect(page.getByRole('status').first()).toHaveText('Copy unavailable');
});
