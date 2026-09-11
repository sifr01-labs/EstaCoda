import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { DesktopConnection } from './connection.js';
import { ServiceProcess } from './service-process.js';
import { denySessionPermissions, lockWindow, securePreferences } from './window-policy.js';
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
async function openWindow(): Promise<void> {
  const window = new BrowserWindow({ width: 1280, height: 860, minWidth: 320, minHeight: 480, show: false,
    webPreferences: securePreferences(path.join(__dirname, 'preload.cjs'), app.isPackaged) });
  denySessionPermissions(window.webContents.session);
  lockWindow(window);
  const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, '.runtime') : path.join(app.getAppPath(), '.runtime');
  const connection = new DesktopConnection(new ServiceProcess(runtimeRoot, app.getPath('home')));
  window.once('closed', () => connection.close());
  connection.switchProfile('default');
  window.once('ready-to-show', () => window.show());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}
void app.whenReady().then(openWindow);
app.on('window-all-closed', () => app.quit());
