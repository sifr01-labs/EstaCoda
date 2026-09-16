import type {SettingChange,SettingValue,SettingsPage} from '@estacoda/control-protocol';

export function webValue(page:SettingsPage,changes:SettingChange[],id:string):SettingValue{
 const pending=changes.find(c=>c.fieldId===id&&!c.selectors.length);
 return pending?pending.value===null?page.web?.defaults.find(c=>c.fieldId===id)?.value??null:pending.value:page.web?.effective.find(c=>c.fieldId===id)?.value??page.values.find(c=>c.fieldId===id)?.value??null;
}
export function localBrowserAddress(address:string){try{const url=new URL(address);return ['http:','https:'].includes(url.protocol)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&!url.hash;}catch{return false;}}
export function browserSelection(value:(id:string)=>SettingValue){return value('browser.backend')==='browserbase'||value('browser.cloudProvider')==='browserbase'&&value('browser.hybridRouting')===true?'cloud':value('browser.backend')==='local-cdp'?(value('browser.autoLaunch')===true?'local':'existing'):'unconfigured';}
export function searchSelectionChanges(id:string,value:(id:string)=>SettingValue):SettingChange[]{
 const change=(fieldId:string,value:SettingValue)=>({fieldId,value,selectors:[]});
 if(id!=='auto')return [change('web.searchBackend',id)];
 // Removing the legacy shared backend must not silently change extraction/crawl routing.
 const shared=value('web.backend');
 return [...(typeof shared==='string'?['web.extractBackend','web.crawlBackend'].filter(key=>value(key)===null).map(key=>change(key,shared)):[]),change('web.backend',null),change('web.searchBackend',null)];
}
