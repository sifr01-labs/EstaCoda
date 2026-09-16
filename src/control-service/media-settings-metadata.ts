import {loadRuntimeConfig,normalizeImageGenerationConfig,normalizeSttConfig,normalizeTtsConfig} from '../config/runtime-config.js';
import {readEnvSecretValue} from '../config/env-secret-store.js';
import {IMAGE_MODEL_OPTIONS} from '../contracts/image-generation.js';
import {resolveAuxiliaryModelRoute} from '../providers/auxiliary-model-resolver.js';
import {settingValue} from '../setup/public-settings.js';
import type {MediaSettingsMetadata,SettingField,SettingValue} from '../contracts/desktop-control/index.js';

/** Read-only projection: never return credential references, environment contents or secret values. */
export async function mediaSettingsMetadata(input:{homeDir:string;profileId:string},fields:SettingField[],env:string,first:boolean):Promise<MediaSettingsMetadata>{
 const loaded=await loadRuntimeConfig({...input,workspaceRoot:input.homeDir,configurationInspection:true});
 const defaults={stt:normalizeSttConfig(undefined),tts:normalizeTtsConfig(undefined),imageGen:normalizeImageGenerationConfig(undefined),voice:{autoTts:false}};
 const effective={stt:loaded.stt,tts:loaded.tts,imageGen:loaded.imageGen,voice:loaded.voice,auxiliaryModels:loaded.auxiliaryModels};
 const secret=(field:SettingField):SettingValue=>{
  const ref=settingValue(effective,field.path);if(typeof ref!=='string')return null;
  const refs=[ref];
  if(/^(?:stt|tts)\.openai\.apiKeyEnv$/.test(field.id))refs.push(ref==='VOICE_TOOLS_OPENAI_KEY'?'OPENAI_API_KEY':'VOICE_TOOLS_OPENAI_KEY');
  return refs.some(key=>Boolean((readEnvSecretValue(env,key)??process.env[key])?.trim()))?'configured':null;
 };
 const safe=fields.filter(f=>!f.path.includes('*')&&!f.path.includes('#'));
 const result:MediaSettingsMetadata={
  effective:safe.map(f=>({fieldId:f.id,selectors:[],value:f.kind==='secret'?secret(f):settingValue(effective,f.path)})),
  defaults:safe.map(f=>({fieldId:f.id,selectors:[],value:f.kind==='secret'?null:settingValue(defaults,f.path)}))
 };
 if(first&&fields.some(f=>f.section==='vision')){
  const resolved=resolveAuxiliaryModelRoute('vision',loaded.auxiliaryModels,{mainRoute:loaded.primaryModelRoute,providerRegistry:loaded.providerRegistry,providerModels:await loaded.providerRegistry.listModels()});
  result.analysis=resolved.route?{providerId:resolved.route.provider,modelId:resolved.route.id}:null;
  result.imageModels=Object.entries(IMAGE_MODEL_OPTIONS).flatMap(([providerId,models])=>models.map(m=>({providerId,id:m.id,label:m.label}))).slice(0,100);
 }
 return result;
}
