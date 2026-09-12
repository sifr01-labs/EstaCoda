import {cpSync,mkdirSync,realpathSync,readFileSync,chmodSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
/** Vite bundles JavaScript but excludes node_modules. Copy only the native PTY
 * package; its N-API binary and spawn-helper are unpacked by Forge's asar policy.
 * The core's standalone Node/SQLite dependency closure is unchanged. */
export function stagePty(buildPath){
 const require=createRequire(new URL('../package.json',import.meta.url));
 const source=dirname(realpathSync(require.resolve('node-pty/package.json')));
 const metadata=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
 if(metadata.version!=='1.1.0')throw new Error('Review PTY packaging before changing its pinned version.');
 const target=join(buildPath,'node_modules/node-pty');mkdirSync(target,{recursive:true});
 for(const name of ['package.json','LICENSE','lib','prebuilds'])cpSync(join(source,name),join(target,name),{recursive:true,dereference:true});
 if(process.platform==='darwin')chmodSync(join(target,'prebuilds',`darwin-${process.arch}`,'spawn-helper'),0o755);
}
