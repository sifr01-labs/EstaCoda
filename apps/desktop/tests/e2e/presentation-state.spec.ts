import {test,expect} from '@playwright/test';
test('serializes rapid language edits, ignores a stale read, and reports failed persistence in the current language',async({page})=>{
 await page.goto('/fixture.html');await page.evaluate(async()=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',ap='/src/renderer/appearance.tsx',lp='/src/renderer/components/language-select.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{AppearanceProvider}=await import(ap),{LanguageSelect}=await import(lp);
  const state={writes:[] as any[],read:()=>{},release:()=>{},fail:false};(window as any).languageTest=state;
  const store={read:()=>new Promise(resolve=>state.read=()=>resolve({theme:'sand',appearance:'dark',density:'compact',language:'en'})),write:(value:any)=>{state.writes.push(value);return state.fail?Promise.reject(new Error('private backend text')):new Promise<void>(resolve=>state.release=resolve);}};
  const root=document.getElementById('root')!;root.remove();const host=document.createElement('div');document.body.append(host);createRoot(host).render(React.createElement(AppearanceProvider,{store},React.createElement(LanguageSelect)));
 });
 await page.getByRole('combobox').selectOption('ar');await page.getByRole('combobox').selectOption('en');await page.evaluate(()=>(window as any).languageTest.read());await expect(page.getByRole('combobox')).toHaveValue('en');
 expect(await page.evaluate(()=>(window as any).languageTest.writes.map((v:any)=>v.language))).toEqual(['ar']);
 await page.evaluate(()=>(window as any).languageTest.release());await expect.poll(()=>page.evaluate(()=>(window as any).languageTest.writes.map((v:any)=>v.language))).toEqual(['ar','en']);
 await page.evaluate(()=>{(window as any).languageTest.release();(window as any).languageTest.fail=true;});await page.getByRole('combobox').selectOption('ar');
 await expect(page.locator('[role=status]')).toContainText('تعذّر');await expect(page.locator('body')).not.toContainText('private backend text');
 await expect(page.locator('#ec-branded-workspace')).toHaveAttribute('data-theme','kemet');
});
test('preserves attachments, model and Work tab selection across language changes',async({page})=>{
 await page.goto('/fixture.html');await page.locator('[data-task="retry"]').click();await page.locator('.ec-composer textarea').fill('راجع src/billing.ts without changing API');
 await page.getByRole('button',{name:'Add attachments',exact:true}).click();await page.getByRole('button',{name:'Try a sample'}).click();await page.locator('#ec-tab-changes').click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('combobox',{name:'Display language'}).focus();await page.getByRole('combobox',{name:'Display language'}).selectOption('ar');await expect(page.getByRole('combobox',{name:'لغة العرض'})).toBeFocused();
 await page.locator('[data-task="retry"]').click();await expect(page.locator('#ec-tab-changes')).toHaveAttribute('aria-selected','true');await expect(page.locator('.ec-composer textarea')).toHaveValue('راجع src/billing.ts without changing API');await expect(page.locator('.ec-attachment')).toContainText('retry-notes.md');await expect(page.locator('.ec-modelcontrol')).toContainText('Kimi K3');
});
test('protected credential window localizes copy while retaining one-shot secret handling',async({page})=>{
 await page.addInitScript(()=>{(window as any).credential={describe:async()=>({language:'ar',provider:'test-provider',purpose:'provider',mode:'browser'}),submit:async(value:string)=>{(window as any).submitted=value;return{accepted:true};},cancel:async()=>{}};});
 await page.goto('/credential.html');await expect(page.locator('html')).toHaveAttribute('dir','rtl');await expect(page.getByRole('heading')).toHaveText('إدخال آمن');await page.locator('#secret').fill('synthetic-test-only');await page.getByRole('button',{name:'إدخال وإرسال'}).click();await expect(page.locator('#secret')).toHaveValue('');await expect(page.getByRole('status')).toHaveText('تم إرسال الإدخال.');expect(await page.evaluate(()=>(window as any).submitted)).toBe('synthetic-test-only');await expect(page.locator('body')).not.toContainText('synthetic-test-only');
});
