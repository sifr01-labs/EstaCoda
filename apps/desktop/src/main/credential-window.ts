import{installAssetProtocol}from'./asset-protocol.js';
import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { WindowAuthority, denySessionPermissions, lockWindow, securePreferences } from './window-policy.js';
import { CredentialPipeClient, type CredentialScope } from './credential-pipe-client.js';
/** Only trusted Main setup transactions may open this window. Ordinary preload
 * has no credential API. PR6 supplies reviewed verification/apply consumers. */
export class CredentialWindow {
  #window: BrowserWindow | null = null;
  #cleanup: (() => void) | null = null;
  constructor(readonly owner: BrowserWindow, readonly preload: string, readonly url: string, readonly packaged: boolean, readonly assetRoot: string) {}
  open(pipe: CredentialPipeClient, binding: Omit<CredentialScope,'windowId'>, accepted: (candidateId: string) => void): void {
    this.close();
    const window = new BrowserWindow({parent:this.owner,modal:true,width:460,height:350,resizable:false,show:false,
      webPreferences:{...securePreferences(this.preload,this.packaged),devTools:false,partition:'credential-'+randomUUID()}});
    this.#window=window;lockWindow(window);denySessionPermissions(window.webContents.session);
    const authority=new WindowAuthority(window,this.url); const scope={...binding,windowId:randomUUID()};
    let busy=false,active=true;
    const authorize=(event: Parameters<WindowAuthority['assertSender']>[0])=>{authority.assertSender(event,0);if(!active)throw new Error('Credential window closed.');};
    // One modal per application. Every call is checked against its exact top frame.
    ipcMain.handle('credential:describe', event=>{authorize(event);return{provider:binding.providerId,purpose:binding.purpose};});
    ipcMain.handle('credential:submit',async(event,value:unknown)=>{
      authorize(event);if(busy||typeof value!=='string'||Buffer.byteLength(value)>49_152)throw new Error('Credential rejected.');
      busy=true;
      try { const candidate=await pipe.stage(scope,value);value='';authorize(event);accepted(candidate);return{accepted:true}; }
      catch {throw new Error('Credential rejected.');} finally {value='';busy=false;}
    });
    ipcMain.handle('credential:cancel',event=>{authorize(event);this.close();});
    this.#cleanup=()=>{
      active=false;authority.invalidate();
      for(const channel of ['credential:describe','credential:submit','credential:cancel'])ipcMain.removeHandler(channel);
      void pipe.closeWindow(scope.windowId,scope.generation).catch(()=>{});
    };
    window.once('closed',()=>{if(this.#window===window){this.#cleanup?.();this.#cleanup=null;this.#window=null;}});
    // A reload must discard staged candidates before a fresh document can submit.
    let loaded=false;
    window.webContents.on('did-start-navigation',()=>{if(loaded)this.close();});
    window.webContents.once('did-finish-load',()=>{loaded=true;});
    window.once('ready-to-show',()=>window.show());
    const prepared=this.url.startsWith('estacoda:')?installAssetProtocol(window.webContents.session,'credential',this.assetRoot):Promise.resolve();
    void prepared.then(()=>window.loadURL(this.url)).catch(()=>this.close());
  }
  close():void {this.#cleanup?.();this.#cleanup=null;const window=this.#window;this.#window=null;if(window&&!window.isDestroyed())window.destroy();}
}
