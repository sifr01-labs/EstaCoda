import{net,protocol,type Session}from'electron';
import{readdirSync,lstatSync}from'node:fs';
import{join}from'node:path';import{pathToFileURL}from'node:url';
export const UI_SCHEME='estacoda';
export function registerUiScheme():void{
 protocol.registerSchemesAsPrivileged([{scheme:UI_SCHEME,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
}
/** Static build assets only. No renderer-supplied filesystem paths or fallbacks. */
export function assetManifest(root:string,host:'app'|'credential'):Map<string,string>{
 const entry=host==='app'?'index.html':'credential.html';
 const files=new Map([[`/${entry}`,pathToFileURL(join(root,entry)).href]]);
 for(const item of readdirSync(join(root,'assets'),{withFileTypes:true})){
  if(!item.isFile()||!/^[A-Za-z0-9_.-]+\.(js|css|svg|png|ttf|txt|woff2?)$/.test(item.name))continue;
  const file=join(root,'assets',item.name);if(lstatSync(file).size>4_194_304)throw Error('UI asset exceeds its build limit.');
  files.set('/assets/'+item.name,pathToFileURL(file).href);
 }
 return files;
}
export function assetUrl(request:string,host:'app'|'credential',files:Map<string,string>):string|undefined{
 try{const url=new URL(request);if(url.protocol!==UI_SCHEME+':'||url.hostname!==host||url.username||url.password||url.port||url.search||url.hash)return;return files.get(url.pathname);}catch{return;}
}
export async function installAssetProtocol(session:Session,host:'app'|'credential',root:string):Promise<void>{
 const files=assetManifest(root,host);
 if(await session.protocol.isProtocolHandled(UI_SCHEME))throw Error('UI protocol already installed.');
 session.protocol.handle(UI_SCHEME,request=>{
  const file=assetUrl(request.url,host,files);
  if(request.method!=='GET'||!file)return new Response('Not found',{status:404});
  return net.fetch(file);
 });
}
