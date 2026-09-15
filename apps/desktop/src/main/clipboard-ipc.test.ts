import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({handlers:new Map<string,Function>(),writeText:vi.fn(),directory:''}));
vi.mock('electron',()=>({clipboard:{writeText:mocks.writeText},app:{getPath:()=>mocks.directory},ipcMain:{handle:(key:string,handler:Function)=>mocks.handlers.set(key,handler),removeHandler:(key:string)=>mocks.handlers.delete(key)}}));
import {installSemanticIpc} from './semantic-ipc.js';
it('writes through Main while browser permissions stay denied, fencing other frames and stale windows',async()=>{
 mocks.directory=mkdtempSync('/tmp/ec-clipboard-ipc-');mocks.writeText.mockClear();
 const url='file:///app/index.html',frame={url};
 const contents=Object.assign(new EventEmitter(),{mainFrame:frame,send:vi.fn()});
 const window={webContents:contents,isDestroyed:()=>false};
 const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1,status:'ready',work:{items:[]},inbox:{items:[]}}});
 const dispose=installSemanticIpc(window as any,url,connection as any,{} as any,{} as any);
 try {
  const run=mocks.handlers.get('desktop:clipboardWrite')!,event={sender:contents,senderFrame:frame},envelope={generation:0,payload:{text:'canonical-chat-id'}};
  await run(event,envelope);expect(mocks.writeText).toHaveBeenCalledWith('canonical-chat-id');
  await expect(run({...event,senderFrame:{url}},envelope)).rejects.toThrow();
  await expect(run(event,{...envelope,generation:99})).rejects.toThrow();
  await expect(run(event,{...envelope,payload:{text:'id',read:true}})).rejects.toThrow();
  expect(mocks.handlers.has('desktop:clipboardRead')).toBe(false);expect(mocks.writeText).toHaveBeenCalledTimes(1);
 }finally{dispose();rmSync(mocks.directory,{recursive:true,force:true});}
});
