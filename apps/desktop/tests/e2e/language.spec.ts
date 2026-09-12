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
