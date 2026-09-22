import {app} from 'electron';
import {join,resolve} from 'node:path';
import {classifyInstallation} from './ownership.js';
import {UpdateCoordinator} from './coordinator.js';
import type {DesktopUpdateState} from '../../shared/desktop-updates.js';
/** Shared by all windows. Signing identity and updater acceptance are not configured yet. */
export class DesktopUpdates {
 readonly coordinator=new UpdateCoordinator(join(app.getPath('userData'),'updates'));
 status():DesktopUpdateState {
  return {phase:'disabled',problem:'release_setup',version:app.getVersion(),automaticChecks:false,installation:classifyInstallation({packaged:app.isPackaged,platform:process.platform,bundle:resolve(process.resourcesPath,'../..'),home:app.getPath('home'),publisherVerified:false})};
 }
}
let shared:DesktopUpdates|undefined;
export function desktopUpdates():DesktopUpdates{return shared??=new DesktopUpdates();}
