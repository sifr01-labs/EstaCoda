import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('credential', Object.freeze({
  describe: () => ipcRenderer.invoke('credential:describe'),
  submit: (value: string) => ipcRenderer.invoke('credential:submit', value),
  cancel: () => ipcRenderer.invoke('credential:cancel'),
}));
