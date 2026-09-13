import {capabilitySettings} from './public-settings-capabilities.js';
import {governanceSettings} from './public-settings-governance.js';
import {runtimeSettings} from './public-settings-runtime.js';
import {browserSettings} from './public-settings-browser.js';
import {voiceSettings} from './public-settings-voice.js';
import {visionSettings} from './public-settings-vision.js';
import {modelSettings} from './public-settings-models.js';
import {ControlProtocolError,type SettingField,type SettingChange,type SettingValue} from '../contracts/desktop-control/index.js';
/** Reviewed allowlist, shared by metadata, projection and apply. Never infer authority from an arbitrary config path. */
export const PUBLIC_SETTINGS:readonly SettingField[]=[
 ...capabilitySettings,...governanceSettings,...runtimeSettings,...modelSettings,...visionSettings,...voiceSettings,...browserSettings,
 {id:'web.brave.apiKeyEnv',path:['web','brave','apiKeyEnv'],section:'browser',kind:'secret'},
 {id:'ui.showResponseProgress',path:['ui','showResponseProgress'],section:'runtime',kind:'boolean'},
 {id:'ui.language',path:['ui','language'],section:'runtime',kind:'choice',choices:['en','ar']},
 {id:'ui.flavor',path:['ui','flavor'],section:'runtime',kind:'choice',choices:['standard','arabic-light','kemet-full']},
 {id:'ui.activityLabels',path:['ui','activityLabels'],section:'runtime',kind:'choice',choices:['en','ar']},
 {id:'profile.mode',path:['profile','mode'],section:'runtime',kind:'choice',choices:['focused','operator','builder','research']},
 {id:'profile.responseLanguage',path:['profile','responseLanguage'],section:'runtime',kind:'choice',choices:['en','ar','match-user']},
];
export function settingField(change:SettingChange,applied=false):SettingField {
 const field=PUBLIC_SETTINGS.find(field=>field.id===change.fieldId);
 if(!field||change.selectors.length!==field.path.filter(part=>part==='*'||part==='#').length||change.selectors.some(part=>!part||part.length>128||['__proto__','constructor','prototype'].includes(part)||/[\0\r\n]/u.test(part)))throw new ControlProtocolError('-32602');
 if(field.id==='mcpServers.*.tools.prefix'&&change.value!==null&&typeof change.value!=='string'&&typeof change.value!=='boolean')throw new ControlProtocolError('-32602');
 if(field.id==='skills.config.*.*'&&/(?:secret|password|token|api.?key|credential|authorization)/i.test(change.selectors[1]!))throw new ControlProtocolError('-32602');
 const v=change.value;if(v===null)return field;
 const valid=field.kind==='scalar'?(typeof v==='string'&&v.length<=4096||typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean'||Array.isArray(v)&&v.length<=128&&v.every(s=>typeof s==='string'&&s.length<=2048)):field.kind==='secret'?typeof v==='string'&&(applied?/^[A-Z][A-Z0-9_]{1,127}$/.test(v):/^[a-f0-9-]{36}$/.test(v)):field.kind==='text'?typeof v==='string'&&v.length<=4096:field.kind==='strings'?Array.isArray(v)&&v.length<=128&&v.every(s=>typeof s==='string'&&s.length<=2048):field.kind==='boolean'?typeof v==='boolean':field.kind==='number'?typeof v==='number'&&Number.isFinite(v)&&v>=(field.min??0)&&v<=(field.max??Number.MAX_SAFE_INTEGER):field.kind==='choice'?field.choices?.includes(v as string):false;
 if(!valid)throw new ControlProtocolError('-32602');
 if(typeof v==='string'&&/(?:^|\.)(baseUrl|cdpUrl|url)$/.test(field.id)){let url:URL;try{url=new URL(v);}catch{throw new ControlProtocolError('-32602');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new ControlProtocolError('-32602');}
 if(field.path.includes('headerRefs')&&!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(change.selectors.at(-1)!))throw new ControlProtocolError('-32602');
 return field;
}
export function settingPath(field:SettingField,selectors:string[]):string[]{let i=0;return field.path.map(part=>part==='*'||part==='#'?selectors[i++]!:part);}
export function settingValue(config:unknown,path:readonly string[]):SettingValue {
 let current=config;for(const part of path){if(!current||typeof current!=='object')return null;const key=Object.hasOwn(current,part)?part:part.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());if(!Object.hasOwn(current,key))return null;current=(current as Record<string,unknown>)[key];}
 if(Buffer.byteLength(JSON.stringify(current)??'null')>12000)throw new ControlProtocolError('-32009');
 return typeof current==='string'||typeof current==='boolean'||typeof current==='number'||Array.isArray(current)&&current.every(v=>typeof v==='string')?structuredClone(current as SettingValue):null;
}
