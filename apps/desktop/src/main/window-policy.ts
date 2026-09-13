import type { BrowserWindow, IpcMainInvokeEvent, Session, WebPreferences } from 'electron';

export function securePreferences(preload: string, packaged: boolean): WebPreferences {
  return { preload, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    webviewTag: false, devTools: !packaged, spellcheck: false };
}
export function denySessionPermissions(session: Session): void {
  session.setPermissionRequestHandler((contents,permission,callback,details)=>{const media=(details as Electron.MediaAccessPermissionRequest).mediaTypes;callback(permission==='media'&&audioAllowed(contents,details)&&Array.isArray(media)&&media.length===1&&media[0]==='audio');});
  session.setPermissionCheckHandler((contents,permission,_origin,details)=>permission==='media'&&details.mediaType==='audio'&&audioAllowed(contents,details));
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', event => event.preventDefault());
}
export function lockWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}
/** Main-owned generation changes on reload, profile change and bridge replacement. */
export class WindowAuthority {
  generation = 0;
  constructor(readonly window: BrowserWindow, readonly documentUrl: string) {}
  invalidate(): void { this.generation++; }
  assertSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, generation: number): void {
    if (this.window.isDestroyed() || generation !== this.generation ||
      event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame ||
      event.senderFrame?.url !== this.documentUrl) throw new Error('Desktop request rejected.');
  }
}

const microphoneWindows=new Map<number,{window:BrowserWindow;url:string}>();
export function setMicrophonePermission(window:BrowserWindow,url:string,enabled:boolean){if(enabled)microphoneWindows.set(window.webContents.id,{window,url});else microphoneWindows.delete(window.webContents.id);}
function audioAllowed(contents:Electron.WebContents|null,details:{requestingUrl?:string;isMainFrame?:boolean}){const grant=contents?microphoneWindows.get(contents.id):undefined;return !!grant&&!grant.window.isDestroyed()&&contents?.getURL()===grant.url&&details.requestingUrl===grant.url&&details.isMainFrame===true;}
