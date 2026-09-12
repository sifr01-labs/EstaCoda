import {chmodSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
// node-pty 1.1.0's macOS prebuild ships spawn-helper without its executable bit.
// Repair only this pinned package asset; never accept a workspace-selected path.
if(process.platform==='darwin'){
 const require=createRequire(import.meta.url),root=dirname(require.resolve('node-pty/package.json'));
 if(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version!=='1.1.0')throw new Error('Review PTY helper preparation for the new version.');
 chmodSync(join(root,'prebuilds',`darwin-${process.arch}`,'spawn-helper'),0o755);
}
