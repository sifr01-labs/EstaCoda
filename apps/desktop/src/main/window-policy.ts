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
export function lockWindow(window: BrowserWindow, developmentUrl?: string): void {
  // Vite reloads its own document after dependency optimization. Blocking that
  // navigation aborts the initial module graph, leaving an empty renderer.
  // Only the exact, already-loaded Main-owned development document may reload.
  const navigation = (event: Electron.Event & { url: string; isMainFrame: boolean }) => {
    if (!developmentUrl || !event.isMainFrame || event.url !== developmentUrl ||
      window.webContents.getURL() !== developmentUrl) event.preventDefault();
  };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', navigation);
  window.webContents.on('will-frame-navigate', navigation);
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
export function setMicrophonePermission(window:BrowserWindow,url:string,enabled:boolean){
 // Revocation also runs after BrowserWindow's closed event, when webContents is destroyed.
 for(const [id,grant] of microphoneWindows)if(grant.window===window)microphoneWindows.delete(id);
 if(enabled&&!window.isDestroyed())microphoneWindows.set(window.webContents.id,{window,url});
}
function audioAllowed(contents:Electron.WebContents|null,details:{requestingUrl?:string;isMainFrame?:boolean}){const grant=contents?microphoneWindows.get(contents.id):undefined;return !!grant&&!grant.window.isDestroyed()&&contents?.getURL()===grant.url&&details.requestingUrl===grant.url&&details.isMainFrame===true;}
