import {test,expect} from '@playwright/test';
test('changes local language in place and preserves the selected draft',async({page})=>{
 await page.goto('/fixture.html');
 const draft=page.locator('.ec-composer textarea');await draft.fill('Keep العربية and /tmp/example.ts unchanged');
 await page.getByRole('button',{name:'Settings',exact:true}).click();const language=page.getByRole('combobox',{name:'Display language',exact:true});await language.focus();await language.selectOption('ar');
 const arabic=page.getByRole('combobox',{name:'لغة العرض',exact:true});await expect(arabic).toBeFocused();await expect(arabic).toHaveValue('ar');await arabic.selectOption('en');
 await expect(page.getByRole('combobox',{name:'Display language',exact:true})).toBeFocused();
 await page.locator('[data-task="welcome"]').click();await expect(page.locator('.ec-composer textarea')).toHaveValue('Keep العربية and /tmp/example.ts unchanged');
});
test('localizes Work and approval controls while preserving commands and user content',async({page})=>{
 await page.goto('/fixture.html?language=ar');await expect(page.getByText('على ماذا تودّ العمل؟',{exact:false})).toBeVisible();
 await page.locator('[data-task="retry"]').click();await expect(page.getByRole('button',{name:'الموافقة مرة واحدة',exact:true})).toBeVisible();
 await expect(page.getByText('pnpm test -- retry',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'رفض',exact:true}).click();await expect(page.getByText('رُفض أمر الاختبار. لم يُتحقق من التعديلات بعد.',{exact:true})).toBeVisible();
 await expect(page.locator('.ec-usernote')).toContainText('billing');
});
test('mirrors shell placement and follows RTL arrow navigation without changing tab identity',async({page})=>{
 await page.setViewportSize({width:1280,height:900});await page.goto('/fixture.html?language=ar');
 await expect(page.locator('html')).toHaveAttribute('lang','ar');await expect(page.locator('html')).toHaveAttribute('dir','rtl');
 await page.locator('[data-task="retry"]').click();
 const sidebar=await page.locator('.ec-sidebar').boundingBox(),main=await page.locator('.ec-main').boundingBox();expect(sidebar!.x).toBeGreaterThan(main!.x);
 await page.locator('#ec-tab-activity').focus();await page.keyboard.press('ArrowLeft');await expect(page.locator('#ec-tab-changes')).toBeFocused();await expect(page.locator('#ec-tab-changes')).toHaveAttribute('aria-selected','true');
 await page.keyboard.press('ArrowRight');await expect(page.locator('#ec-tab-activity')).toBeFocused();
 await page.getByRole('button',{name:'إظهار لوحة التفاصيل',exact:true}).click();
 const inspector=await page.locator('.ec-inspector').boundingBox(),center=await page.locator('.ec-workcenter').boundingBox();expect(inspector!.x).toBeLessThan(center!.x);
});
test('loads the bundled Arabic font and keeps technical commands LTR',async({page})=>{
 const fonts:string[]=[];page.on('response',r=>{if(r.url().endsWith('.ttf')&&r.ok())fonts.push(r.url());});
 await page.goto('/fixture.html?language=ar');await page.evaluate(()=>document.fonts.ready);
 expect(await page.locator('#ec-branded-workspace').evaluate(e=>getComputedStyle(e).fontFamily)).toContain('Noto Sans Arabic');
 expect(await page.evaluate(()=>document.fonts.check('14px "Noto Sans Arabic"','الموافقة'))).toBe(true);expect(fonts).toEqual([expect.stringContaining('/assets/NotoSansArabic.ttf')]);
 await page.locator('[data-task="retry"]').click();const code=page.locator('.ec-command code');await expect(code).toHaveText('pnpm test -- retry');
 expect(await code.evaluate(e=>getComputedStyle(e).direction)).toBe('ltr');expect(await code.evaluate(e=>getComputedStyle(e).unicodeBidi)).toBe('isolate');
});
