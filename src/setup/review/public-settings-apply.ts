import {validateMcpSetupInput,normalizeAuxiliarySlotInput,setupAuxiliaryModelConfig,readConfig,saveRuntimeConfig,loadRuntimeConfig,setupUiConfig,setupProfileConfig,type UiSetupInput,type ProfileSetupInput} from '../../config/runtime-config.js';
import {resolveProfileStateHome} from '../../config/profile-home.js';
import {settingField,settingPath,settingValue} from '../public-settings.js';
import type {SettingChange} from '../../contracts/desktop-control/index.js';
/** Runs inside the existing isolated profile transaction. Field metadata is the write allowlist. */
export async function applyPublicSettings(changes:SettingChange[],input:{homeDir:string;profileId:string}){
 const configPath=resolveProfileStateHome(input).configPath,current=await readConfig(configPath),config=current.config;
 if(changes.some(c=>c.fieldId.startsWith('mcpServers.'))&&!config.mcpServers&&config.mcp_servers)config.mcpServers=structuredClone(config.mcp_servers);
 if(changes.some(c=>c.fieldId.startsWith('imageGen.'))&&!config.imageGen&&config.image_gen)config.imageGen=structuredClone(config.image_gen);
 if(!Array.isArray(changes)||!changes.length||changes.length>32)throw new Error('Invalid settings changes');
 for(const change of changes){
  if(change.fieldId.startsWith('model.fallbacks.#.')&&!config.model?.fallbacks?.[Number(change.selectors[0])])throw new Error('Choose an existing fallback route');
  const field=settingField(change,true);if(field.envName)continue;const path=settingPath(field,change.selectors);let node=config as Record<string,unknown>;
  for(const [index,part] of path.slice(0,-1).entries()){if(index===1&&path[0]==='auxiliaryModels'&&typeof node[part]==='string')node[part]=normalizeAuxiliarySlotInput(node[part] as string,field.id); if(node[part]===undefined)node[part]={};if(!node[part]||typeof node[part]!=='object'||Array.isArray(node[part])&&!(field.path[index+1]==='#'&&Number(path[index+1])<(node[part] as unknown[]).length))throw new Error('Unsupported settings shape');node=node[part] as Record<string,unknown>;}
  if(path.includes('envRefs')){const owner=path.slice(0,-2).reduce((o,k)=>(o as Record<string,unknown>)[k],config as unknown) as Record<string,unknown>;if(owner.env&&typeof owner.env==='object')delete (owner.env as Record<string,unknown>)[path.at(-1)!];}
  if(path.includes('headerRefs')){const owner=path.slice(0,-2).reduce((o,k)=>(o as Record<string,unknown>)[k],config as unknown) as Record<string,unknown>;const headers=owner.headers;for(const values of [headers,owner.headerRefs])if(values&&typeof values==='object')for(const name of Object.keys(values))if(name.toLowerCase()===path.at(-1)!.toLowerCase())delete (values as Record<string,unknown>)[name];}
  const key=path.at(-1)!;if(change.value===null)delete node[key];else node[key]=structuredClone(change.value);
 }
 for(const name of new Set(changes.filter(c=>c.fieldId.startsWith('mcpServers.')).map(c=>c.selectors[0]!))){const server=config.mcpServers?.[name];if(server)validateMcpSetupInput({name,...server});}
 await saveRuntimeConfig(configPath,config);
 // Reuse public CLI normalization/validation in the staging profile, before live commit.
 const options={...input,workspaceRoot:input.homeDir};
 for(const slot of new Set(changes.filter(c=>c.fieldId.startsWith('auxiliaryModels.')&&!c.fieldId.startsWith('auxiliaryModels.default.')).map(c=>c.fieldId.split('.')[1]!))){
  const value=normalizeAuxiliarySlotInput(config.auxiliaryModels?.[slot as import('../../contracts/provider.js').AuxiliaryModelTask],slot);
  if(value)await setupAuxiliaryModelConfig({...options,input:{...value,task:slot as import('../../contracts/provider.js').AuxiliaryModelTask,provider:value.provider??'auto'}});
 }

 if(changes.some(c=>c.fieldId.startsWith('ui.')))await setupUiConfig({...options,input:config.ui as UiSetupInput});
 if(changes.some(c=>c.fieldId.startsWith('profile.')))await setupProfileConfig({...options,input:config.profile as ProfileSetupInput});
 const loaded=await loadRuntimeConfig({...options,configurationInspection:true});
 // Coercing a reviewed value to a different effective value would misrepresent the apply.
 for(const change of changes){if(change.value===null||!['memory','compression','delegation','externalMemory','budgets'].includes(change.fieldId.split('.')[0]!))continue;
  const expected=change.value,actual=settingValue(loaded,settingPath(settingField(change,true),change.selectors));
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Reviewed setting is outside the supported runtime bounds');
 }

}
