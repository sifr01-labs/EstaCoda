import {constants} from 'node:fs';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,mkdtemp,mkdir,rm,open,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {PackRegistry} from '../packs/pack-registry.js';
import {validatePackManifest} from '../packs/pack-validator.js';
import {classifyPackRisk} from '../packs/pack-risk-classifier.js';
import {installPack,enablePack,disablePack,uninstallPack} from '../packs/pack-installer.js';
import {ControlProtocolError,type SettingsAction} from '../contracts/desktop-control/index.js';
/** Bounded source identity includes skill content, not only the permission manifest. */
async function fingerprint(root:string){let bytes=0,files=0;const hash=createHash('sha256');
 async function walk(path:string,depth:number):Promise<void>{if(depth>12||++files>256)throw new ControlProtocolError('-32009');const stat=await lstat(path);if(stat.isSymbolicLink())throw new ControlProtocolError('-32003');hash.update(path.slice(root.length));if(stat.isDirectory()){for(const entry of (await readdir(path)).sort())await walk(join(path,entry),depth+1);}else{if(!stat.isFile()||stat.size>1048576||(bytes+=stat.size)>33554432)throw new ControlProtocolError('-32009');hash.update(await readFile(path));}}
 await walk(root,0);return hash.digest('hex');
}
export async function reviewSettingsPack(input:{homeDir:string;profileId:string},action:SettingsAction){
 if(action.value!=='')throw new ControlProtocolError('-32602');
 const install=action.action==='pack.install';if(!install&&!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(action.subject))throw new ControlProtocolError('-32602');
 const registry=new PackRegistry(input),old=install?undefined:await registry.find(action.subject);if(!install&&!old)throw new ControlProtocolError('-32003');
 const root=install?resolve(action.subject):join(input.homeDir,'.estacoda','packs',action.subject),digest=await fingerprint(root);
 const parsed=validatePackManifest(JSON.parse(await readFile(join(root,'pack.json'),'utf8')));if(!parsed.ok)throw new ControlProtocolError('-32003');
 const manifest=parsed.manifest,risk=classifyPackRisk(manifest);if(['pack.install','pack.enable'].includes(action.action)&&risk.level==='blocked')throw new ControlProtocolError('-32003');
 if(install&&await registry.find(manifest.id))throw new ControlProtocolError('-32003');
 const facts=[input.profileId,manifest.name,manifest.id,risk.level,JSON.stringify(manifest.permissions),JSON.stringify(manifest.sandbox),root];if(facts.some(f=>f.length>4096))throw new ControlProtocolError('-32009');
 return {baseline:JSON.stringify([digest,old??null]),facts};
}
async function snapshotPack(input:{homeDir:string;profileId:string},source:string){
 const root=resolveProfileStateHome(input).tempPath;await mkdir(root,{recursive:true,mode:0o700});const dest=await mkdtemp(join(root,'desktop-pack-'));let count=0,total=0;
 async function copy(from:string,to:string,depth:number):Promise<void>{if(++count>256||depth>12)throw new ControlProtocolError('-32009');const stat=await lstat(from);if(stat.isSymbolicLink())throw new ControlProtocolError('-32003');if(stat.isDirectory()){await mkdir(to,{mode:0o700});for(const name of await readdir(from))await copy(join(from,name),join(to,name),depth+1);return;}const file=await open(from,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await file.stat();if(!st.isFile()||st.size>1048576||(total+=st.size)>33554432)throw new ControlProtocolError('-32009');const buffer=Buffer.alloc(st.size+1);let size=0;while(size<buffer.length){const r=await file.read(buffer,size,buffer.length-size,size);if(!r.bytesRead)break;size+=r.bytesRead;}if(size!==st.size)throw new ControlProtocolError('-32003');await writeFile(to,buffer.subarray(0,size),{flag:'wx',mode:0o600});}finally{await file.close();}}
 try{const content=join(dest,'content');await copy(resolve(source),content,0);return {dest,content};}catch(error){await rm(dest,{recursive:true,force:true});throw error;}
}
export async function executeSettingsPack(input:{homeDir:string;profileId:string},action:SettingsAction,baseline:string){
 const common={...input,actor:'desktop',id:action.subject};
 if(action.action==='pack.install'){const snapshot=await snapshotPack(input,action.subject);try{if(JSON.stringify([await fingerprint(snapshot.content),null])!==baseline)return false;return (await installPack({...common,sourcePath:snapshot.content,prompt:async()=> 'yes'})).ok;}finally{await rm(snapshot.dest,{recursive:true,force:true});}}
 const result=action.action==='pack.enable'?await enablePack(common):action.action==='pack.disable'?await disablePack(common):await uninstallPack(common);
 return result.ok;
}
