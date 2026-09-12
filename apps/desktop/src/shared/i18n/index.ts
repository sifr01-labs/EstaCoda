import {arabic,english,type MessageKey} from './catalog.js';
export type DisplayLanguage='en'|'ar';
export const isDisplayLanguage=(value:unknown):value is DisplayLanguage=>value==='en'||value==='ar';
export {type MessageKey};
/** Deterministic English fallback; inserted technical values are directionally isolated. */
export function translate(language:DisplayLanguage,key:MessageKey,values:Readonly<Record<string,string|number>>={}):string{
 const source=Object.prototype.hasOwnProperty.call(english,key)?english[key]:english['Message unavailable.'];
 const message=language==='ar'&&Object.prototype.hasOwnProperty.call(arabic,key)?arabic[key]:source;
 return message.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g,(token,name:string)=>Object.prototype.hasOwnProperty.call(values,name)?'\u2068'+String(values[name])+'\u2069':token);
}
