import {lstat} from 'node:fs/promises';
import {resolveGlobalStateHome} from '../config/profile-home.js';
import {ControlProtocolError,type CandidateRoute} from '../contracts/desktop-control/index.js';
import {captureProfileApplySnapshot} from '../setup/review/profile-apply.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {readEnvSecretValue} from '../config/env-secret-store.js';
import {getProviderMetadata} from '../providers/provider-metadata.js';
import {validateCandidateRequest} from './candidate-verification.js';

/** Explicit source selection only. Never resolve credentials from process.env or another profile. */
export async function readImportSource(destination:{homeDir:string;profileId:string},sourceProfileId:string){
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(sourceProfileId)||sourceProfileId===destination.profileId)throw new ControlProtocolError('-32602');
 const global=resolveGlobalStateHome(destination);
 for(const path of [global.stateRoot,global.profilesRoot]){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new ControlProtocolError('-32003');}
 const target=await captureProfileApplySnapshot(destination);
 if(target.files['config.json']!==null)throw new ControlProtocolError('-32003');
 const input={homeDir:destination.homeDir,profileId:sourceProfileId},snapshot=await captureProfileApplySnapshot(input);
 if(!snapshot.files['config.json'])throw new ControlProtocolError('-32003');
 const loaded=await loadRuntimeConfig({...input,workspaceRoot:input.homeDir,configurationInspection:true});
 if(JSON.stringify(snapshot.files)!==JSON.stringify((await captureProfileApplySnapshot(input)).files))throw new ControlProtocolError('-32007');
 return [loaded.primaryModelRoute,...loaded.modelFallbackRoutes.slice(0,32)].flatMap((model,index)=>{
  const metadata=getProviderMetadata(model.provider),provider=loaded.config.providers?.[model.provider];
  // Custom headers can depend on other credentials; don't silently copy an incomplete connection.
  if(!metadata.configurable||!metadata.runnable||!provider?.enableNetwork||Object.keys(provider.headers??{}).length)return [];
  const auth=model.authMethod??provider.authMethod??metadata.defaultAuthMethod;
  const endpoint=model.baseUrl??provider.baseUrl??metadata.defaultBaseUrl;
  if(!endpoint||model.provider==='unconfigured')return [];
  const route:CandidateRoute={providerId:model.provider,modelId:model.id,endpoint,authMethod:auth==='none'?'none':auth==='api_key'?'api_key':'oauth',apiMode:(provider.apiMode??metadata.apiMode) as CandidateRoute['apiMode'],enableNetwork:true,allowPrivateEndpoint:true,...(model.contextWindowTokens?{contextWindowTokens:model.contextWindowTokens}:{}),...(model.maxTokens?{maxTokens:model.maxTokens}:{})};
  try{validateCandidateRequest({windowId:'import',generation:1,route,spendApproved:true,...(route.authMethod!=='none'?{candidateId:'import'}:{})});}catch{return [];}
  const env=model.apiKeyEnv??provider.apiKeyEnv??metadata.defaultApiKeyEnv;
  const value=route.authMethod==='api_key'&&env?readEnvSecretValue(snapshot.files['.env']??'',env):undefined;
  return [{id:index===0?'primary':`fallback-${index-1}`,route,value}];
 });
}
