import {test,expect,_electron as electron} from '@playwright/test';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {translate} from '../../src/shared/i18n/index.js';
const executablePath=createRequire(import.meta.url)('electron') as string;
for(const language of ['en','ar'] as const)for(const mode of ['light','dark'] as const)test(`native Electron zoom and accessibility ${language} ${mode}`,async({},info)=>{
 test.skip(process.platform!=='darwin','Native macOS acceptance; browser coverage remains cross-platform.');
 const temp=mkdtempSync(join(tmpdir(),'ec-native-language-')),main=join(temp,'main.cjs');
 writeFileSync(main,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temp,'userData'))});app.whenReady().then(async()=>{const w=new BrowserWindow({width:1280,height:900,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await w.loadURL(${JSON.stringify(`http://127.0.0.1:5317/fixture.html?language=${language}&mode=${mode}`)});});app.on('window-all-closed',()=>app.quit());`);
 let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
 try{
  app=await electron.launch({executablePath,args:[main]});const page=await app.firstWindow();await expect(page.locator('html')).toHaveAttribute('lang',language);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2));
  await page.getByRole('button',{name:translate(language,'Settings'),exact:true}).click();const select=page.getByRole('combobox',{name:translate(language,'Display language')});await select.focus();await expect(select).toBeFocused();await expect(select).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>document.fonts.ready);const ax=await app.evaluate(async({BrowserWindow})=>{const debug=BrowserWindow.getAllWindows()[0]!.webContents.debugger;debug.attach('1.3');try{return await debug.sendCommand('Accessibility.getFullAXTree');}finally{debug.detach();}});
  const controls=ax.nodes.filter((node:any)=>!node.ignored&&['combobox','button'].includes(node.role?.value)).map((node:any)=>({role:node.role.value,name:node.name?.value}));expect(controls).toContainEqual({role:'combobox',name:translate(language,'Display language')});
  await info.attach('native-accessibility-controls',{body:JSON.stringify(controls,null,2),contentType:'application/json'});const capture=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'));writeFileSync(info.outputPath(`native-${language}-${mode}-zoom200.png`),Buffer.from(capture,'base64'));
 }finally{await app?.close();rmSync(temp,{recursive:true,force:true});}
});
