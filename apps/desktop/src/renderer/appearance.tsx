import {LanguageContext} from './i18n.js';
import {translate,type MessageKey} from '../shared/i18n/index.js';
import{createContext,useContext,useEffect,useRef,useState,type ReactNode}from'react';
import{DEFAULT_APPEARANCE,type AppearancePreferences,type AppearanceStore}from'../shared/appearance.js';
const Context=createContext<{preferences:AppearancePreferences;change:(value:Partial<AppearancePreferences>)=>void;error:string}>({preferences:DEFAULT_APPEARANCE,change:()=>{},error:''});
export function AppearanceProvider({store,children}:{store:AppearanceStore;children:ReactNode}){
 const[preferences,setPreferences]=useState({...DEFAULT_APPEARANCE});const[error,setError]=useState('');const edits=useRef(0),current=useRef(preferences),writes=useRef(Promise.resolve());
 useEffect(()=>{let active=true;const initial=edits.current;void Promise.resolve().then(()=>store.read()).then(value=>{if(active&&initial===edits.current){current.current={...DEFAULT_APPEARANCE,...value};setPreferences(current.current);}}).catch(()=>{if(active)setError('Appearance preferences are unavailable.');});return()=>{active=false;};},[store]);
 useEffect(()=>{document.documentElement.lang=preferences.language??'en';document.documentElement.dir=preferences.language==='ar'?'rtl':'ltr';},[preferences.language]);
 const change=(value:Partial<AppearancePreferences>)=>{const revision=++edits.current;const next={...current.current,...value};current.current=next;setPreferences(next);writes.current=writes.current.catch(()=>{}).then(()=>store.write(next)).then(()=>{if(revision===edits.current)setError('');}).catch(()=>{if(revision===edits.current)setError('Appearance changed for this window, but could not be saved.');});};
 return <Context.Provider value={{preferences,change,error}}><LanguageContext.Provider value={preferences.language??'en'}><div id="ec-branded-workspace" data-theme={preferences.theme} data-appearance={preferences.appearance} data-density={preferences.density} aria-label={translate(preferences.language??'en','EstaCoda desktop')}>{children}<div className="ec-sr-only" role="status">{error?translate(preferences.language??'en',error as MessageKey):''}</div></div></LanguageContext.Provider></Context.Provider>;
}
export function useAppearance(){return useContext(Context);}
