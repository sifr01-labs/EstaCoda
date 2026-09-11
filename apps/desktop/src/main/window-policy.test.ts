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
