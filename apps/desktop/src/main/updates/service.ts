import {app} from 'electron';
import {join,resolve} from 'node:path';
import {DESKTOP_PROTOCOL_VERSION} from '@estacoda/control-protocol';
import {TASK_MODEL_OVERRIDE_SCHEMA_VERSION} from '../../../../../src/tasks/task-schema.js';
import {classifyInstallation} from './ownership.js';
import {UpdateCoordinator} from './coordinator.js';
import {UpdateDiscovery} from './discovery.js';
import {UpdateLocalState} from './local-state.js';
import {releasePolicy} from './release-policy.js';
/** Shared by all windows; release pins remain absent until signing acceptance. */
export class DesktopUpdates extends UpdateDiscovery {
 private readonly local=new UpdateLocalState(join(app.getPath('userData'),'updates'));
 readonly coordinator=new UpdateCoordinator(join(app.getPath('userData'),'updates'));
 constructor(){super({version:app.getVersion(),platform:process.platform,arch:process.arch,os:((process.getSystemVersion?.()??'0').split('.').concat(['0','0']).slice(0,3).join('.')),protocol:DESKTOP_PROTOCOL_VERSION.major,schema:TASK_MODEL_OVERRIDE_SCHEMA_VERSION,publicKey:releasePolicy.publicKey,teamId:releasePolicy.teamId,installation:()=>classifyInstallation({packaged:app.isPackaged,platform:process.platform,bundle:resolve(process.resourcesPath,'../..'),home:app.getPath('home'),publisherVerified:false})});const prefs=this.local.read('preferences.json') as {automaticChecks?:unknown}|null;super.preferences(prefs?.automaticChecks===true);}
 override preferences(automaticChecks:boolean){this.local.write('preferences.json',{automaticChecks});return super.preferences(automaticChecks);}
}
let shared:DesktopUpdates|undefined;
export function desktopUpdates():DesktopUpdates{return shared??=new DesktopUpdates();}
