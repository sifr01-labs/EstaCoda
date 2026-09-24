import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export type DesktopRuntimeBuild={workspaceRoot:string;digest:string};
/** Backend-selected immutable Desktop runtime. Never accepts a renderer path.
 * Full content verification is performed before activating it as a user service.
 * Publisher authentication is owned by Desktop's installer/retention boundary. */
export function inspectDesktopRuntimeBuild(workspaceRoot=fileURLToPath(new URL('../../',import.meta.url)),executable=process.execPath,verify=false):DesktopRuntimeBuild|undefined {
 try {
  workspaceRoot=realpathSync(workspaceRoot);
  const root=dirname(workspaceRoot),digest=basename(root);
  if(basename(workspaceRoot)!=='core'||basename(dirname(root))!=='runtime-versions'||!/^[a-f0-9]{64}$/.test(digest))return;
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
  const node=join(root,process.platform==='win32'?'node.exe':'node');
  if(realpathSync(executable)!==node||manifest.version!==2||manifest.platform!==process.platform||manifest.arch!==process.arch||manifest.runtimeSha256!==digest)return;
  if(verify){
   const files:Array<{path:string;bytes:number;sha256:string}>=[];let total=0,entries=0;
   const walk=(relative:string,depth:number)=>{
    if(depth>32||++entries>100000)throw Error('Invalid runtime inventory');
    const path=join(root,relative),info=lstatSync(path);
    if(info.isSymbolicLink())throw Error('Linked runtime asset');
    if(info.isDirectory()){for(const name of readdirSync(path).sort())if(relative||name!=='manifest.json')walk(relative?relative+'/'+name:name,depth+1);}
    else{if(!info.isFile()||info.size>512*1024*1024||(total+=info.size)>2*1024*1024*1024)throw Error('Invalid runtime asset');files.push({path:relative,bytes:info.size,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});}
   };
   walk('',0);
   if(JSON.stringify(files)!==JSON.stringify(manifest.files)||createHash('sha256').update(JSON.stringify(files)).digest('hex')!==digest||files.find(f=>f.path==='core/dist/index.js')?.sha256!==manifest.entrySha256||files.find(f=>f.path===basename(node))?.sha256!==manifest.nodeSha256)return;
  }
  return {workspaceRoot,digest};
 }catch{return;}
}
