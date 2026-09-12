import {DesktopModelSetup} from './model-setup.js';
import{registerUiScheme,installAssetProtocol}from'./asset-protocol.js';
import{AppearanceSettings}from'./appearance-store.js';
import { app, BrowserWindow } from 'electron';
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
  lockWindow(window);
  const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, '.runtime') : path.join(app.getAppPath(), '.runtime');
  const connection = new DesktopConnection(new ServiceProcess(runtimeRoot, app.getPath('home')));
  const credentialRoot=path.join(__dirname,`../renderer/${CREDENTIAL_WINDOW_VITE_NAME}`);
  const credentialUrl = CREDENTIAL_WINDOW_VITE_DEV_SERVER_URL ? new URL('credential.html', CREDENTIAL_WINDOW_VITE_DEV_SERVER_URL).href : 'estacoda://credential/credential.html';
  const credentials = new CredentialWindow(window, path.join(__dirname, 'credential-preload.cjs'), credentialUrl, app.isPackaged, credentialRoot);
  let credentialPipe: CredentialPipeClient | undefined;
  connection.on('credentials', (pipe: Duplex) => { credentialPipe?.dispose(); credentialPipe = new CredentialPipeClient(pipe); });
  connection.on('invalidate', () => { credentials.close(); credentialPipe?.dispose(); credentialPipe = undefined; });
  const documentUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).href : 'estacoda://app/index.html';
  const profiles = new Profiles(app.getPath('home'));
  const disposeIpc = installSemanticIpc(window, documentUrl, connection, profiles, new AppearanceSettings(app.getPath('userData')),new DesktopModelSetup(connection,credentials,()=>credentialPipe));
  window.once('closed', () => { disposeIpc(); connection.close(); });
  connection.switchProfile(profiles.initial());
  window.once('ready-to-show', () => window.show());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else {await installAssetProtocol(window.webContents.session,'app',path.join(__dirname,`../renderer/${MAIN_WINDOW_VITE_NAME}`));await window.loadURL(documentUrl);}
}
void app.whenReady().then(openWindow);
app.on('window-all-closed', () => app.quit());
