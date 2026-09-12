import {test,expect,type Page} from '@playwright/test';
import {translate,type DisplayLanguage} from '../../src/shared/i18n/index.js';
const openWork=async(page:Page,language:DisplayLanguage)=>{
 if(page.viewportSize()!.width<590){await page.locator('.ec-navgroup').getByRole('button',{name:new RegExp(translate(language,'Inbox'))}).click();await page.getByRole('button',{name:translate(language,'Review request'),exact:true}).click();}
 else await page.locator('[data-task="retry"]').click();
};
for(const language of ['en','ar'] as const)for(const mode of ['light','dark'] as const)for(const width of [360,1280])for(const view of ['approval','settings','models'] as const){
 test(`bilingual ${language} ${mode} ${width} ${view}`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.goto(`/fixture.html?language=${language}&mode=${mode}`);await expect(page.locator('html')).toHaveAttribute('lang',language);
  if(view==='approval')await openWork(page,language);
  else{await page.getByRole('button',{name:translate(language,'Settings'),exact:true}).click();if(view==='models')await page.locator('.ec-settingslink').filter({hasText:translate(language,'Models & providers')}).click();}
  await page.evaluate(()=>document.fonts.ready);await page.mouse.move(0,0);await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.locator('.ec-window')).toHaveScreenshot(`pr14a-${language}-${mode}-${width}-${view}.png`,{animations:'disabled'});
  const tree=await page.locator('.ec-window').ariaSnapshot();expect(tree).not.toContain('Message unavailable.');expect(tree).not.toContain('الرسالة غير متاحة.');
  if(view==='approval'){expect(tree).toContain(translate(language,'Approve once'));expect(tree).toContain(translate(language,'Reject'));expect(tree).toContain('pnpm test -- retry');}
  if(view==='settings'){expect(tree).toContain(translate(language,'Display language'));expect(tree).toContain('English');expect(tree).toContain('العربية');}
 });
}
for(const language of ['en','ar'] as const)for(const mode of ['light','dark'] as const)test(`bilingual 200 percent reflow ${language} ${mode}`,async({page})=>{
 await page.setViewportSize({width:1280,height:900});await page.goto(`/fixture.html?language=${language}&mode=${mode}`);await page.evaluate(()=>{document.documentElement.style.zoom='2';});
 await page.getByRole('button',{name:translate(language,'Settings'),exact:true}).click();const select=page.getByRole('combobox',{name:translate(language,'Display language')});await select.focus();await expect(select).toBeFocused();await expect(select).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.keyboard.press('Tab');await expect(page.locator('.ec-settingslink').first()).toBeFocused();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:translate(language,'Appearance'),exact:true})).toBeVisible();
 await page.evaluate(()=>document.fonts.ready);await expect(page.locator('.ec-window')).toHaveScreenshot(`pr14a-${language}-${mode}-zoom200.png`,{animations:'disabled'});
});
