import {DesktopWorkInput} from './work-secure-input.js';
import {DesktopPublicSettings} from './public-settings.js';
import {translate,type MessageKey} from '../shared/i18n/index.js';
import {DesktopBrowserControls} from './browser-controls.js';
import {DesktopTerminalControls} from './terminal-controls.js';
import {DesktopTargetControls} from './target-controls.js';
import {DesktopConnectionControls} from './connection-controls.js';
import {DesktopTelegramSetup} from './telegram-setup.js';
import {WorkOperationReferences} from './work-operation-references.js';
import {DesktopWorkControls} from './work-controls.js';
import {WorkPins} from './work-pins.js';
import {DesktopModelSetup} from './model-setup.js';
import{registerUiScheme,installAssetProtocol}from'./asset-protocol.js';
import{AppearanceSettings}from'./appearance-store.js';
import { dialog,shell,app, BrowserWindow } from 'electron';
import path from 'node:path';
import { Profiles } from './profiles.js';
import { installSemanticIpc } from './semantic-ipc.js';
import { CredentialWindow } from './credential-window.js';
import { CredentialPipeClient } from './credential-pipe-client.js';
import type { Duplex } from 'node:stream';
import { DesktopConnection } from './connection.js';
import { ServiceProcess } from './service-process.js';
import { denySessionPermissions, lockWindow, securePreferences } from './window-policy.js';
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const CREDENTIAL_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const CREDENTIAL_WINDOW_VITE_NAME: string;
registerUiScheme();
async function openWindow(): Promise<void> {
  const window = new BrowserWindow({ width: 1280, height: 860, frame: process.platform === 'darwin', ...(process.platform === 'darwin' ? {titleBarStyle:'hiddenInset' as const,trafficLightPosition:{x:14,y:14}} : {}), backgroundColor: '#131313', minWidth: 320, minHeight: 480, show: false,
    webPreferences: securePreferences(path.join(__dirname, 'preload.cjs'), app.isPackaged) });
  denySessionPermissions(window.webContents.session);
  lockWindow(window, !app.isPackaged && MAIN_WINDOW_VITE_DEV_SERVER_URL ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).href : undefined);
  const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, '.runtime') : path.join(app.getAppPath(), '.runtime');
  const connection = new DesktopConnection(new ServiceProcess(runtimeRoot, app.getPath('home')));
  const credentialRoot=path.join(__dirname,`../renderer/${CREDENTIAL_WINDOW_VITE_NAME}`);
  const credentialUrl = CREDENTIAL_WINDOW_VITE_DEV_SERVER_URL ? new URL('credential.html', CREDENTIAL_WINDOW_VITE_DEV_SERVER_URL).href : 'estacoda://credential/credential.html';
  const presentation=new AppearanceSettings(app.getPath('userData'));
  const t=(key:MessageKey)=>translate(presentation.read().language??'en',key);
  const credentials = new CredentialWindow(window, path.join(__dirname, 'credential-preload.cjs'), credentialUrl, app.isPackaged, credentialRoot,()=>presentation.read().language??'en',()=>presentation.read());
  let credentialPipe: CredentialPipeClient | undefined;
  connection.on('credentials', (pipe: Duplex) => { credentialPipe?.dispose(); credentialPipe = new CredentialPipeClient(pipe); });
  connection.on('invalidate', () => { credentials.close(); credentialPipe?.dispose(); credentialPipe = undefined; });
  const documentUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).href : 'estacoda://app/index.html';
  const profiles = new Profiles(app.getPath('home'));
  const browsers=new DesktopBrowserControls(connection,async url=>{const result=await dialog.showMessageBox(window,{type:'warning',title:t('Take browser control'),message:t('Take control of this browser?'),detail:'\u2066'+url+'\u2069'+'\n\n'+t('Browser actions by the agent will pause. Your clicks and keys can submit forms or change external services. Return control explicitly when finished. Closing or losing this window leaves browser execution paused.'),buttons:[t('Cancel'),t('Take control')],defaultId:0,cancelId:0,noLink:true});return result.response===1;},async(entry,deliver)=>new Promise<boolean>(resolve=>{
    credentials.open({stage:async(_scope,value)=>{await deliver(value);return 'delivered';},closeWindow:async()=>{}},
      {windowId:'browser-signin',generation:connection.state.generation,purpose:'provider',providerId:entry.kind+' at '+entry.origin,authMethod:'api_key',endpoint:entry.origin},()=>resolve(true),()=>resolve(false),'browser');
  }),params=>{if(!credentialPipe)throw new Error('Protected entry pipe unavailable.');return credentialPipe.deliverBrowser(params);});
  window.on('closed',()=>browsers.dispose());
  window.on('close',()=>browsers.detach());
  window.webContents.on('render-process-gone',()=>browsers.detach());
  window.on('unresponsive',()=>browsers.detach());
  const terminals=new DesktopTerminalControls(connection,async root=>{
    const result=await dialog.showMessageBox(window,{type:'warning',title:t('Open workspace terminal'),message:t('Open a terminal for this workspace?'),detail:'\u2066'+root+'\u2069'+'\n\n'+t('Commands run with your selected execution policy. A Local host terminal can access files beyond this directory. Terminal input does not approve agent actions.'),buttons:[t('Cancel'),t('Open terminal')],defaultId:0,cancelId:0,noLink:true});return result.response===1;
  },app.getPath('home'));
  const workInput=new DesktopWorkInput(connection,()=>credentialPipe,(entry,deliver)=>new Promise<boolean>(resolve=>{
    credentials.open({stage:async(_scope,value)=>{await deliver(value);return 'delivered';},closeWindow:async()=>{}},{windowId:'work-signin',generation:connection.state.generation,purpose:'provider',providerId:t(entry.kind==='password'?'Password':entry.kind==='one-time-code'?'One-time code':entry.kind==='account-identifier'?'Account identifier':'Secure value')+' · '+entry.origin+' · '+entry.position+'/'+entry.total,authMethod:'api_key',endpoint:entry.origin},()=>resolve(true),()=>resolve(false),'work',{label:t(entry.kind==='password'?'Password':entry.kind==='one-time-code'?'One-time code':entry.kind==='account-identifier'?'Account identifier':'Secure value'),origin:entry.origin,position:entry.position,total:entry.total});
  }),()=>credentials.close());
  window.on('closed',()=>workInput.dispose());
  window.on('unresponsive',()=>workInput.invalidate());
  window.webContents.on('render-process-gone',()=>workInput.invalidate());
  let closing=false;
  window.on('close',event=>{if(closing)return;event.preventDefault();void terminals.dispose().then(()=>{closing=true;window.close();}).catch(()=>{void dialog.showMessageBox(window,{type:'error',message:t('Terminal shutdown could not be confirmed.'),detail:t('The target remains protected from cleanup. Retry closing after checking the terminal process.')});});});
  const disposeIpc = installSemanticIpc(window, documentUrl, connection, profiles, presentation,new DesktopModelSetup(connection,credentials,()=>credentialPipe,new WorkOperationReferences(connection,app.getPath('userData')),url=>shell.openExternal(url)),new WorkPins(app.getPath('userData'),connection),new DesktopWorkControls(connection,app.getPath('userData'),async()=>{const result=await dialog.showOpenDialog(window,{title:t('Attach images (up to 8 MB) or text (up to 8 KB)'),properties:['openFile','multiSelections']});return result.canceled?[]:result.filePaths;}),new DesktopTelegramSetup(connection,credentials,()=>credentialPipe),new DesktopConnectionControls(connection,app.getPath('userData')),new DesktopTargetControls(connection,app.getPath('userData')),terminals,browsers,new DesktopPublicSettings(connection,credentials,()=>credentialPipe,new DesktopConnectionControls(connection,path.join(app.getPath('userData'),'dependencies'))),workInput);
  window.once('closed', () => { disposeIpc(); connection.close(); });
  connection.switchProfile(profiles.initial());
  window.once('ready-to-show', () => window.show());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else {await installAssetProtocol(window.webContents.session,'app',path.join(__dirname,`../renderer/${MAIN_WINDOW_VITE_NAME}`));await window.loadURL(documentUrl);}
}
void app.whenReady().then(openWindow);
app.on('window-all-closed', () => app.quit());
