import React from 'react';
import{BrandEye,Wordmark,Topline,Button}from'./components/primitives.js';
import{AppearanceView}from'./components/appearance-view.js';
export function App(){const[settings,setSettings]=React.useState(false);return <div className="ec-window">{settings?<AppearanceView back={()=>setSettings(false)}/>:<><Topline label="New chat"><Button icon="settings-2" aria-label="Appearance" onClick={()=>setSettings(true)}/></Topline><main className="ec-workcenter"><div className="ec-newwelcome"><BrandEye/><Wordmark/><p>A place to think clearly and get work done.</p></div></main></>}</div>;}
