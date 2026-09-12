import {readConfig,saveRuntimeConfig,loadRuntimeConfig,setupUiConfig,setupProfileConfig,type UiSetupInput,type ProfileSetupInput} from '../../config/runtime-config.js';
import {resolveProfileStateHome} from '../../config/profile-home.js';
import {settingField,settingPath} from '../public-settings.js';
import type {SettingChange} from '../../contracts/desktop-control/index.js';
/** Runs inside the existing isolated profile transaction. Field metadata is the write allowlist. */
export async function applyPublicSettings(changes:SettingChange[],input:{homeDir:string;profileId:string}){
 const configPath=resolveProfileStateHome(input).configPath,current=await readConfig(configPath),config=current.config;
 if(!Array.isArray(changes)||!changes.length||changes.length>32)throw new Error('Invalid settings changes');
 for(const change of changes){
  const field=settingField(change,true),path=settingPath(field,change.selectors);let node=config as Record<string,unknown>;
  for(const part of path.slice(0,-1)){if(node[part]===undefined)node[part]={};if(!node[part]||typeof node[part]!=='object'||Array.isArray(node[part]))throw new Error('Unsupported settings shape');node=node[part] as Record<string,unknown>;}
  const key=path.at(-1)!;if(change.value===null)delete node[key];else node[key]=structuredClone(change.value);
 }
 await saveRuntimeConfig(configPath,config);
 // Reuse public CLI normalization/validation in the staging profile, before live commit.
 const options={...input,workspaceRoot:input.homeDir};
 if(changes.some(c=>c.fieldId.startsWith('ui.')))await setupUiConfig({...options,input:config.ui as UiSetupInput});
 if(changes.some(c=>c.fieldId.startsWith('profile.')))await setupProfileConfig({...options,input:config.profile as ProfileSetupInput});
 await loadRuntimeConfig({...options,configurationInspection:true});
}
