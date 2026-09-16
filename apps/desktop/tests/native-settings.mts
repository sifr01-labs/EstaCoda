/** Run after desktop:package: real renderer/preload/IPC and owned runtime, isolated profile. */
import {_electron,expect} from '@playwright/test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {SQLiteSessionDB} from '../../../src/session/sqlite-session-db.ts';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../../../src/config/profile-home.ts';
const home=mkdtempSync(join(tmpdir(),'ec-native-settings-')),desktop=resolve('apps/desktop');
const profile=resolveProfileStateHome({homeDir:home,profileId:'default'});
mkdirSync(profile.profileRoot,{recursive:true});
writeFileSync(profile.configPath,JSON.stringify({browser:{backend:'local-cdp',headless:false},web:{enableNetwork:true},security:{allowPrivateUrls:false}}));
const database=new SQLiteSessionDB({path:resolveGlobalStateHome({homeDir:home}).sessionsSqlitePath});database.close();
const harness=join(home,'entry.cjs');
writeFileSync(harness,`const {app}=require('electron');app.setPath('home',${JSON.stringify(home)});app.setPath('userData',${JSON.stringify(join(home,'ui'))});app.setAppPath(${JSON.stringify(desktop)});require(${JSON.stringify(join(desktop,'.vite/build/main.cjs'))});`);
let application:Awaited<ReturnType<typeof _electron.launch>>|undefined;
try{
 application=await _electron.launch({executablePath:join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[harness],env:{...process.env,HOME:home}});
 const page=await application.firstWindow();
 await expect.poll(()=>page.evaluate(async()=>(await window.desktop.snapshot()).status),{timeout:30000}).toBe('ready');
 const metadata=await page.evaluate(async()=>{const pages=[];let offset:number|undefined=0;do{const page=await window.desktop.settings!.read('browser',offset);pages.push({fields:page.fields.length,metadata:Boolean(page.web)});offset=page.nextOffset;}while(offset!==undefined);return pages;});
 expect(metadata.length).toBeGreaterThan(1);expect(metadata.every(p=>p.metadata&&p.fields>0)).toBe(true);
 const connections=await page.evaluate(()=>window.desktop.connections!.list());expect(connections.items[0]?.telegram?.configured).toBe(false);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.locator('.ec-settingslink').filter({hasText:'Browser & Search'}).click();
 await expect(page.getByRole('heading',{name:'Web search',exact:true})).toBeVisible();
 await expect(page.getByText('Settings request failed. Refresh and review again.',{exact:true})).toHaveCount(0);
 await page.locator('.ec-navgroup').getByRole('button',{name:'Connections',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Connected services',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Connections unavailable',exact:true})).toHaveCount(0);
 console.log('Native settings pages loaded through renderer, preload, IPC, strict protocol, and owned runtime.');
}finally{await application?.close();rmSync(home,{recursive:true,force:true});}
