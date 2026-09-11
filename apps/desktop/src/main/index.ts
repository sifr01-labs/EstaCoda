import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { Profiles } from './profiles.js';
import { installSemanticIpc } from './semantic-ipc.js';
import { pathToFileURL } from 'node:url';
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
async function openWindow(): Promise<void> {
  const window = new BrowserWindow({ width: 1280, height: 860, minWidth: 320, minHeight: 480, show: false,
    webPreferences: securePreferences(path.join(__dirname, 'preload.cjs'), app.isPackaged) });
  denySessionPermissions(window.webContents.session);
  lockWindow(window);
  const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, '.runtime') : path.join(app.getAppPath(), '.runtime');
  const connection = new DesktopConnection(new ServiceProcess(runtimeRoot, app.getPath('home')));
  const credentialUrl = CREDENTIAL_WINDOW_VITE_DEV_SERVER_URL ? new URL('credential.html', CREDENTIAL_WINDOW_VITE_DEV_SERVER_URL).href : pathToFileURL(path.join(__dirname, `../renderer/${CREDENTIAL_WINDOW_VITE_NAME}/credential.html`)).href;
  const credentials = new CredentialWindow(window, path.join(__dirname, 'credential-preload.cjs'), credentialUrl, app.isPackaged);
  let credentialPipe: CredentialPipeClient | undefined;
  connection.on('credentials', (pipe: Duplex) => { credentialPipe?.dispose(); credentialPipe = new CredentialPipeClient(pipe); });
  connection.on('invalidate', () => { credentials.close(); credentialPipe?.dispose(); credentialPipe = undefined; });
  const documentUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).href : pathToFileURL(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)).href;
  const profiles = new Profiles(app.getPath('home'));
  const disposeIpc = installSemanticIpc(window, documentUrl, connection, profiles);
  window.once('closed', () => { disposeIpc(); connection.close(); });
  connection.switchProfile(profiles.initial());
  window.once('ready-to-show', () => window.show());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}
void app.whenReady().then(openWindow);
app.on('window-all-closed', () => app.quit());
