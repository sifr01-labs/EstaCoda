import {test,expect} from '@playwright/test';
test('changes local language in place and preserves the selected draft',async({page})=>{
 await page.goto('/fixture.html');
 const draft=page.locator('.ec-composer textarea');await draft.fill('Keep العربية and /tmp/example.ts unchanged');
 await page.getByRole('button',{name:'Settings',exact:true}).click();const language=page.getByRole('combobox',{name:'Display language',exact:true});await language.focus();await language.selectOption('ar');
 const arabic=page.getByRole('combobox',{name:'لغة العرض',exact:true});await expect(arabic).toBeFocused();await expect(arabic).toHaveValue('ar');await arabic.selectOption('en');
 await expect(page.getByRole('combobox',{name:'Display language',exact:true})).toBeFocused();
 await page.locator('[data-task="welcome"]').click();await expect(page.locator('.ec-composer textarea')).toHaveValue('Keep العربية and /tmp/example.ts unchanged');
});
