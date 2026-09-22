import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {detectInstallMethod} from '../lifecycle/install-method.js';
/** Build-owned metadata travels with retained runtime generations outside the .app.
 * It only restricts lifecycle operations to the owner; it grants no execution authority. */
export function desktopDistribution(moduleUrl:string):boolean {
 if(/\.app\/Contents\/Resources\//.test(fileURLToPath(moduleUrl)))return true;
 try{const metadata=JSON.parse(readFileSync(new URL('../../package.json',moduleUrl),'utf8'));return metadata.name==='estacoda'&&metadata.estacodaDistribution==='desktop-bundle';}catch{return false;}
}
/** Desktop never mutates CLI-owned installations or its own live runtime assets. */
export async function settingsLifecycle(version:string){const owner=desktopDistribution(import.meta.url)?'desktop-bundle':(await detectInstallMethod({includeCwd:false,moduleUrl:import.meta.url})).method;return {version,owner,update:'owner_required' as const,uninstall:'owner_required' as const};}
