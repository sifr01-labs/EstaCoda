import {createContext,useContext} from 'react';
import {translate,type DisplayLanguage,type MessageKey} from '../shared/i18n/index.js';
export const LanguageContext=createContext<DisplayLanguage>('en');
export function useI18n(){const language=useContext(LanguageContext);return {language,t:(key:MessageKey,values?:Readonly<Record<string,string|number>>)=>translate(language,key,values)};}
