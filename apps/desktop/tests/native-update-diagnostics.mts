/** Built Main/preload/renderer, isolated HOME, native save-dialog boundary. */
import { _electron, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
const home = mkdtempSync('/tmp/ec-native-update-diagnostics-'), desktop = resolve('apps/desktop');
const harness = join(home, 'entry.cjs'), output = join(home, 'diagnostics.json');
writeFileSync(harness, `const {app}=require('electron');app.setPath('home',${JSON.stringify(home)});app.setPath('userData',${JSON.stringify(join(home, 'ui'))});app.setAppPath(${JSON.stringify(desktop)});require(${JSON.stringify(join(desktop, '.vite/build/main.cjs'))});`);
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  application = await _electron.launch({ executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [harness], env: { ...process.env, HOME: home } });
  const page = await application.firstWindow();
  await expect.poll(() => page.evaluate(async () => (await window.desktop.snapshot()).status), { timeout: 30000 }).toBe('ready');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath }); }, output);
  await page.evaluate(() => window.desktop.updates!.diagnostics()); expect(existsSync(output)).toBe(false);
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await page.evaluate(() => window.desktop.updates!.diagnostics());
  const content = readFileSync(output, 'utf8');
  expect(content).not.toContain(home);
  expect(JSON.parse(content)).toMatchObject({ format: 1, phase: 'disabled', releasePinsConfigured: false, updaterAccepted: false, canReplace: false });
  expect(Object.keys(JSON.parse(content)).sort()).toEqual(['format', 'desktopVersion', 'offeredVersion', 'platform', 'arch', 'ownership', 'canReplace', 'phase', 'problem', 'automaticChecks', 'releasePinsConfigured', 'updaterAccepted'].sort());
  console.log('Native update diagnostics: cancel writes nothing; chosen export contains only reviewed bounded status fields.');
} finally { await application?.close(); await new Promise(resolve => setTimeout(resolve, 1700)); rmSync(home, { recursive: true, force: true }); }
