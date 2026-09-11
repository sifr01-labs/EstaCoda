import{createContext,useContext,useEffect,useRef,useState,type ReactNode}from'react';
import{DEFAULT_APPEARANCE,type AppearancePreferences,type AppearanceStore}from'../shared/appearance.js';
const Context=createContext<{preferences:AppearancePreferences;change:(value:Partial<AppearancePreferences>)=>void;error:string}>({preferences:DEFAULT_APPEARANCE,change:()=>{},error:''});
export function AppearanceProvider({store,children}:{store:AppearanceStore;children:ReactNode}){
 const[preferences,setPreferences]=useState({...DEFAULT_APPEARANCE});const[error,setError]=useState('');const edits=useRef(0);
 useEffect(()=>{let active=true;const initial=edits.current;void Promise.resolve().then(()=>store.read()).then(value=>{if(active&&initial===edits.current)setPreferences(value);}).catch(()=>{if(active)setError('Appearance preferences are unavailable.');});return()=>{active=false;};},[store]);
 const change=(value:Partial<AppearancePreferences>)=>{edits.current++;const next={...preferences,...value};setPreferences(next);void store.write(next).then(()=>setError('')).catch(()=>setError('Appearance changed for this window, but could not be saved.'));};
 return <Context.Provider value={{preferences,change,error}}><div id="ec-branded-workspace" data-theme={preferences.theme} data-appearance={preferences.appearance} data-density={preferences.density} aria-label="EstaCoda desktop">{children}<div className="ec-sr-only" role="status">{error}</div></div></Context.Provider>;
}
export function useAppearance(){return useContext(Context);}
