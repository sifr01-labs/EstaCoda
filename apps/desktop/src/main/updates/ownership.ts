import {accessSync,constants,lstatSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import type {InstallationStatus,InstallOwnership} from '../../shared/desktop-updates.js';
export function classifyInstallation(input:{packaged:boolean;platform:string;bundle:string;home:string;publisherVerified:boolean}):InstallationStatus {
 const status=(ownership:InstallOwnership):InstallationStatus=>({ownership,canReplace:ownership==='owned'});
 if(!input.packaged)return status('development');
 if(input.platform!=='darwin')return status('unsupported');
 if(input.bundle.includes('/AppTranslocation/'))return status('translocated');
 if(input.bundle.startsWith('/Volumes/'))return status('mounted');
 try{
  const actual=realpathSync(input.bundle);
  if(actual!==resolve(input.bundle)||!lstatSync(actual).isDirectory())return status('external');
  if(![join('/Applications','EstaCoda.app'),join(realpathSync(input.home),'Applications','EstaCoda.app')].includes(actual))return status('external');
  accessSync(actual,constants.W_OK);accessSync(dirname(actual),constants.W_OK);
  return status(input.publisherVerified?'owned':'unverified');
 }catch{return status('read_only');}
}
