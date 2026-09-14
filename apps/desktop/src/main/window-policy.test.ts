import { describe, expect, it } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { securePreferences, WindowAuthority } from './window-policy.js';
describe('window authority', () => {
  it('rejects other windows, subframes, changed documents and stale generations', () => {
    const frame = { url: 'file:///app/index.html' };
    const contents = { mainFrame: frame };
    const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
    const authority = new WindowAuthority(window, frame.url);
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    expect(() => authority.assertSender(event, 0)).not.toThrow();
    expect(() => authority.assertSender({ ...event, sender: {} } as IpcMainInvokeEvent, 0)).toThrow();
    expect(() => authority.assertSender({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent, 0)).toThrow();
    frame.url = 'https://attacker.invalid';
    expect(() => authority.assertSender(event, 0)).toThrow();
    frame.url = 'file:///app/index.html'; authority.invalidate();
    expect(() => authority.assertSender(event, 0)).toThrow();
  });
  it('disables runtime access and production devtools', () => {
    expect(securePreferences('/owned/preload.cjs', true)).toMatchObject({ sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, devTools: false });
  });
});
it('allows microphone only for an explicitly granted main document and never camera',async()=>{const {denySessionPermissions,setMicrophonePermission}=await import('./window-policy.js');let request:any,check:any;denySessionPermissions({setPermissionRequestHandler:(f:any)=>request=f,setPermissionCheckHandler:(f:any)=>check=f,setDevicePermissionHandler:()=>{},on:()=>{}} as any);const url='file:///app/index.html',contents={id:99,getURL:()=>url},window={isDestroyed:()=>false,webContents:contents} as unknown as BrowserWindow;function allowed(details:any){let value=false;request(contents,'media',(v:boolean)=>value=v,details);return value;}const audio={requestingUrl:url,isMainFrame:true,mediaTypes:['audio']};expect(allowed(audio)).toBe(false);setMicrophonePermission(window,url,true);expect(allowed(audio)).toBe(true);expect(allowed({...audio,mediaTypes:['audio','video']})).toBe(false);expect(allowed({...audio,isMainFrame:false})).toBe(false);expect(allowed({...audio,requestingUrl:'https://other.invalid'})).toBe(false);expect(check(contents,'media','file://',{requestingUrl:url,isMainFrame:true,mediaType:'audio'})).toBe(true);setMicrophonePermission(window,url,false);expect(allowed(audio)).toBe(false);});

it('revokes microphone grants after window destruction without accessing destroyed contents',async()=>{
 const {denySessionPermissions,setMicrophonePermission}=await import('./window-policy.js');let request:any,destroyed=false;
 const url='estacoda://app/index.html',contents={id:100,getURL:()=>url};
 const window={isDestroyed:()=>destroyed,get webContents(){if(destroyed)throw new Error('Object has been destroyed');return contents;}} as unknown as BrowserWindow;
 denySessionPermissions({setPermissionRequestHandler:(f:any)=>request=f,setPermissionCheckHandler:()=>{},setDevicePermissionHandler:()=>{},on:()=>{}} as any);
 setMicrophonePermission(window,url,true);destroyed=true;
 expect(()=>setMicrophonePermission(window,url,false)).not.toThrow();expect(()=>setMicrophonePermission(window,url,true)).not.toThrow();
 let allowed=true;request(contents,'media',(v:boolean)=>allowed=v,{requestingUrl:url,isMainFrame:true,mediaTypes:['audio']});expect(allowed).toBe(false);
});

it('allows only a reload of the exact loaded development main document',async()=>{
 const {lockWindow}=await import('./window-policy.js');
 const listeners=new Map<string,(event:any)=>void>();let current='http://localhost:5173/';let open:any;
 const window={webContents:{getURL:()=>current,on:(name:string,handler:any)=>listeners.set(name,handler),setWindowOpenHandler:(handler:any)=>{open=handler;}}} as unknown as BrowserWindow;
 const prevented=(name:string,url=current,isMainFrame=true)=>{let denied=false;listeners.get(name)!({url,isMainFrame,preventDefault:()=>{denied=true;}});return denied;};
 lockWindow(window,current);
 for(const event of ['will-navigate','will-frame-navigate']){
  expect(prevented(event)).toBe(false);
  for(const url of ['https://attacker.invalid/','http://localhost:5174/','http://localhost:5173/credential.html','http://localhost:5173/?other','http://localhost:5173/#other'])expect(prevented(event,url)).toBe(true);
  expect(prevented(event,current,false)).toBe(true);
  current='about:blank';expect(prevented(event,'http://localhost:5173/')).toBe(true);current='http://localhost:5173/';
 }
 expect(prevented('will-redirect')).toBe(true);expect(prevented('will-attach-webview')).toBe(true);expect(open()).toEqual({action:'deny'});
 lockWindow(window);
 expect(prevented('will-navigate')).toBe(true);expect(prevented('will-frame-navigate')).toBe(true);
});
