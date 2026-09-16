import {loadRuntimeConfig,normalizeBrowserConfig} from '../config/runtime-config.js';
import {readEnvSecretValue} from '../config/env-secret-store.js';
import {resolveGlobalStateHome} from '../config/profile-home.js';
import {resolveRuntimeCredential} from '../providers/runtime-credential-resolver.js';
import {braveProvider} from '../tools/web-research-providers/brave-provider.js';
import {ddgsProvider} from '../tools/web-research-providers/ddgs-provider.js';
import {firecrawlProvider} from '../tools/web-research-providers/firecrawl-provider.js';
import {parallelProvider} from '../tools/web-research-providers/parallel-provider.js';
import {tavilyProvider} from '../tools/web-research-providers/tavily-provider.js';
import {exaProvider} from '../tools/web-research-providers/exa-provider.js';
import {searxngProvider} from '../tools/web-research-providers/searxng-provider.js';
import {settingValue} from '../setup/public-settings.js';
import type {SettingField,WebSettingsMetadata} from '../contracts/desktop-control/index.js';

/** Profile-bound, read-only setup projection. Availability does not mean a live test passed. */
export async function webSettingsMetadata(input:{homeDir:string;profileId:string},fields:SettingField[],env:string,first:boolean):Promise<WebSettingsMetadata>{
 const loaded=await loadRuntimeConfig({...input,workspaceRoot:input.homeDir,configurationInspection:true});
 const effective={browser:loaded.browser,web:loaded.web,security:{allowPrivateUrls:loaded.security.allowPrivateUrls}};
 const browserDefaults=normalizeBrowserConfig(undefined);
 const conditionalDefaults=normalizeBrowserConfig({backend:loaded.browser.backend,cloudProvider:loaded.browser.cloudProvider});
 browserDefaults.supervised=conditionalDefaults.supervised;browserDefaults.hybridRouting=conditionalDefaults.hybridRouting;
 const defaults={browser:browserDefaults,web:{enableNetwork:false},security:{allowPrivateUrls:settingValue(loaded.config,['browser','allowPrivateUrls'])??false}};
 const ref=(f:SettingField)=>f.envName??(f.id==='web.brave.apiKeyEnv'?loaded.web.brave?.apiKeyEnv??'BRAVE_SEARCH_API_KEY':undefined);
 const present=(key:string)=>Boolean((readEnvSecretValue(env,key)??process.env[key])?.trim());
 const safe=fields.filter(f=>!f.path.includes('*')&&!f.path.includes('#'));
 const result:WebSettingsMetadata={effective:safe.map(f=>({fieldId:f.id,selectors:[],value:f.kind==='secret'?(ref(f)&&present(ref(f)!)?'configured':null):settingValue(effective,f.path)})),defaults:safe.map(f=>({fieldId:f.id,selectors:[],value:f.kind==='secret'?null:settingValue(defaults,f.path)}))};
 if(first){
  const key=loaded.web.brave?.apiKeyEnv??'BRAVE_SEARCH_API_KEY';
  const context={config:loaded.web,fetch:async()=>{throw new Error('Setup inspection cannot make network requests');},pythonStateRoot:resolveGlobalStateHome(input).stateRoot,credentialResolver:(options:Parameters<typeof resolveRuntimeCredential>[0])=>resolveRuntimeCredential({...options,...input,readOnly:true,environment:{[key]:readEnvSecretValue(env,key)??process.env[key]}})};
  // These are the runtime's built-in search providers in its automatic preference order.
  // Deferred providers never become selectable merely because an environment variable exists.
  const providers=[firecrawlProvider,parallelProvider,tavilyProvider,exaProvider,searxngProvider,braveProvider,ddgsProvider];
  result.searchProviders=await Promise.all(providers.map(async p=>{const configured=p.configure?.(context)??p,implemented=typeof configured.search==='function';return{id:p.name,label:p.displayName,implemented,available:implemented&&(await configured.getAvailability()).available};}));
  const explicit=loaded.web.searchBackend??loaded.web.backend;
  result.resolvedSearch=explicit??result.searchProviders.find(p=>p.available)?.id??null;
 }
 return result;
}
