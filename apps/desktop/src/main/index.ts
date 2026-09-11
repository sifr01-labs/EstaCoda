import { app, BrowserWindow } from 'electron';
import path from 'node:path';
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
async function openWindow(): Promise<void> {
  const window = new BrowserWindow({ width: 1280, height: 860, minWidth: 320, minHeight: 480, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false } });
  window.once('ready-to-show', () => window.show());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}
void app.whenReady().then(openWindow);
app.on('window-all-closed', () => app.quit());
