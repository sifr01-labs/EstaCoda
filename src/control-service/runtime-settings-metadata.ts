import {normalizeUiConfig,normalizeProfileConfig,type EstaCodaConfig} from '../config/runtime-config.js';
import {parseExecutionPolicy} from '../execution/docker-policy.js';
import {DOCKER_DEFAULT_LIMITS} from '../execution/docker-limits.js';
import {settingValue} from '../setup/public-settings.js';
import type {SettingField,RuntimeSettingsMetadata} from '../contracts/desktop-control/index.js';

/** Uses the captured selected-profile snapshot. No process, network, or credential inspection. */
export function runtimeSettingsMetadata(config:EstaCodaConfig,fields:SettingField[]):RuntimeSettingsMetadata {
 const policy=parseExecutionPolicy(config.execution),docker=policy.backend==='docker';
 const defaults={execution:{backend:'host',workspaceAccess:{value:'read-write'},commandNetwork:{value:docker?'disabled':'unrestricted'},lifetime:{value:docker?'session':'host'},...(docker?{credentialCapabilities:{value:[]},limits:{value:DOCKER_DEFAULT_LIMITS}}:{})},ui:normalizeUiConfig({language:config.ui?.language}),profile:normalizeProfileConfig(undefined)};
 const execution={...defaults.execution,...policy,...(docker?{limits:{...policy.limits,value:{...DOCKER_DEFAULT_LIMITS,...policy.limits?.value}}}:{})};
 const effective={execution,ui:normalizeUiConfig(config.ui),profile:normalizeProfileConfig(config.profile)};
 return {effective:fields.map(f=>({fieldId:f.id,selectors:[],value:settingValue(effective,f.path)})),defaults:fields.map(f=>({fieldId:f.id,selectors:[],value:settingValue(defaults,f.path)}))};
}
