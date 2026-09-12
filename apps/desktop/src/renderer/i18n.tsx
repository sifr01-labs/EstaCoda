import {displayStatus} from '../shared/i18n/status.js';
import {createContext,useContext} from 'react';
import {english} from '../shared/i18n/catalog.js';
import {translate,type DisplayLanguage,type MessageKey} from '../shared/i18n/index.js';
export const LanguageContext=createContext<DisplayLanguage>('en');
export function useI18n(){const language=useContext(LanguageContext);return {language,status:(value:string)=>displayStatus(language,value),owned:(key:string)=>key?translate(language,(Object.prototype.hasOwnProperty.call(english,key)?key:'Message unavailable.') as MessageKey):'',t:(key:MessageKey,values?:Readonly<Record<string,string|number>>)=>translate(language,key,values)};}
