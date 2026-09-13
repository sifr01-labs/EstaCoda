import {fileURLToPath} from 'node:url';import {detectInstallMethod} from '../lifecycle/install-method.js';
/** Desktop may inspect installation ownership, but never mutate a CLI-owned installation or its own running bundle. */
export async function settingsLifecycle(version:string){const bundled=/\.app\/Contents\/Resources\//.test(fileURLToPath(import.meta.url));const owner=bundled?'desktop-bundle':(await detectInstallMethod({includeCwd:false,moduleUrl:import.meta.url})).method;return {version,owner,update:'owner_required' as const,uninstall:'owner_required' as const};}
