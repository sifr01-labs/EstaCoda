import type {BrowserBackend} from '../contracts/browser.js';
import type {BrowserControlOwner} from './control-lease.js';
/** Gate the complete runtime backend, including raw CDP and protected-field transports.
 * New backend operations inherit the fence. Only inert status and final disposal bypass it. */
export function gateBrowserBackend(backend:BrowserBackend,owner:BrowserControlOwner):BrowserBackend{
 return new Proxy(backend,{get(target,key,receiver){
  const value=Reflect.get(target,key,receiver);if(typeof value!=='function')return value;
  if(key==='status'||key==='isAvailable')return value.bind(target);
  if(key==='isSensitiveInputActive'||key==='takeProtectedFieldDeliveryResult')return(...args:unknown[])=>owner.agentSync(()=>value.apply(target,args));
  if(key==='close')return(...args:unknown[])=>{owner.close();return value.apply(target,args);};
  return(...args:unknown[])=>owner.agent(async()=>value.apply(target,args));
 }});
}
