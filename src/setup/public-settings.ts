import {ControlProtocolError,type SettingField,type SettingChange,type SettingValue} from '../contracts/desktop-control/index.js';
/** Reviewed allowlist, shared by metadata, projection and apply. Never infer authority from an arbitrary config path. */
export const PUBLIC_SETTINGS:readonly SettingField[]=[
 {id:'ui.language',path:['ui','language'],section:'runtime',kind:'choice',choices:['en','ar']},
 {id:'ui.flavor',path:['ui','flavor'],section:'runtime',kind:'choice',choices:['standard','arabic-light','kemet-full']},
 {id:'ui.activityLabels',path:['ui','activityLabels'],section:'runtime',kind:'choice',choices:['en','ar']},
 {id:'profile.mode',path:['profile','mode'],section:'runtime',kind:'choice',choices:['focused','operator','builder','research']},
 {id:'profile.responseLanguage',path:['profile','responseLanguage'],section:'runtime',kind:'choice',choices:['en','ar','match-user']},
];
export function settingField(change:SettingChange):SettingField {
 const field=PUBLIC_SETTINGS.find(field=>field.id===change.fieldId);
 if(!field||change.selectors.length!==field.path.filter(part=>part==='*'||part==='#').length||change.selectors.some(part=>!part||part.length>128||['__proto__','constructor','prototype'].includes(part)||/[\0\r\n]/u.test(part)))throw new ControlProtocolError('-32602');
 const v=change.value;if(v===null)return field;
 const valid=field.kind==='text'?typeof v==='string'&&v.length<=4096:field.kind==='strings'?Array.isArray(v)&&v.length<=128&&v.every(s=>typeof s==='string'&&s.length<=2048):field.kind==='boolean'?typeof v==='boolean':field.kind==='number'?typeof v==='number'&&Number.isFinite(v)&&v>=(field.min??0)&&v<=(field.max??Number.MAX_SAFE_INTEGER):field.kind==='choice'?field.choices?.includes(v as string):false;
 if(!valid)throw new ControlProtocolError('-32602');return field;
}
export function settingPath(field:SettingField,selectors:string[]):string[]{let i=0;return field.path.map(part=>part==='*'||part==='#'?selectors[i++]!:part);}
export function settingValue(config:unknown,path:readonly string[]):SettingValue {
 let current=config;for(const part of path){if(!current||typeof current!=='object'||!Object.hasOwn(current,part))return null;current=(current as Record<string,unknown>)[part];}
 return typeof current==='string'||typeof current==='boolean'||typeof current==='number'||Array.isArray(current)&&current.every(v=>typeof v==='string')?structuredClone(current as SettingValue):null;
}
