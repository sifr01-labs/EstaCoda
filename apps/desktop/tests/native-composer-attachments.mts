/** Verify genuine File objects cross the actual isolated preload without exposing a path API. */
import {build} from 'vite';
import {_electron,expect} from '@playwright/test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const temp=mkdtempSync(join(tmpdir(),'ec-native-composer-'));
const entry=join(temp,'main.cjs'),file=join(temp,'notes.md');
try{
 await build({configFile:false,logLevel:'error',build:{outDir:join(temp,'build'),lib:{entry:resolve('apps/desktop/src/preload/index.ts'),formats:['cjs'],fileName:()=> 'preload.cjs'},rollupOptions:{external:['electron']}}});
 writeFileSync(file,'Native user-selected attachment');
 writeFileSync(entry,`
 const {app,BrowserWindow,ipcMain}=require('electron');
 app.setPath('userData',${JSON.stringify(join(temp,'profile'))});
 const calls=[];globalThis.attachmentCalls=calls;
 ipcMain.handle('desktop:bind',()=>({generation:1,snapshot:{status:'ready'}}));
 ipcMain.handle('desktop:workAttachFiles',(_event,input)=>{calls.push(input);return[{id:'staged',name:'notes.md',type:'text/plain',size:31}];});
 app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(join(temp,'build','preload.cjs'))},contextIsolation:true,nodeIntegration:false,sandbox:true}});await window.loadURL('data:text/html,<input type="file" multiple>');});
 `);
 const app=await _electron.launch({args:[entry]});
 try{
  const page=await app.firstWindow();await page.locator('input').setInputFiles(file);
  const result=await page.evaluate(async()=>window.desktop.work!.attachFiles!({draftId:'draft',target:{targetId:'t',targetGeneration:1}},Array.from(document.querySelector('input')!.files!)));
  expect(result[0]?.id).toBe('staged');expect(await app.evaluate(()=> (globalThis as any).attachmentCalls)).toEqual([{generation:1,payload:{draftId:'draft',target:{targetId:'t',targetGeneration:1},paths:[file]}}]);
  for(const kind of ['synthetic','object','string']){
   expect(await page.evaluate(async kind=>{let file:any=kind==='synthetic'?new File(['forged'],'notes.md'):kind==='object'?{path:'/private/secret',name:'notes.md'}:'/private/secret';try{await window.desktop.work!.attachFiles!({draftId:'draft',target:{targetId:'t',targetGeneration:1}},[file]);return false;}catch{return true;}},kind)).toBe(true);
  }
  expect(await app.evaluate(()=>(globalThis as any).attachmentCalls.length)).toBe(1);
  console.log('Native file staging crosses isolated preload; synthetic files and forged paths are rejected.');
 }finally{await app.close();}
}finally{rmSync(temp,{recursive:true,force:true});}
