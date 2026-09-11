import{fixtureAdapter}from'./adapter.js';
// Separate build entry. No Electron/preload import, real state, or credentials.
import React from 'react';import{createRoot}from'react-dom/client';
import{AppearanceProvider}from'../renderer/appearance.js';import{App}from'../renderer/app.js';
import{DEFAULT_APPEARANCE,type AppearancePreferences}from'../shared/appearance.js';
import '../renderer/styles/tokens.css';import '../renderer/styles/components.css';import '../renderer/styles/native.css';import '../renderer/styles/theme-previews.css';
const adapter=fixtureAdapter();
createRoot(document.getElementById('root')!).render(<React.StrictMode><AppearanceProvider store={adapter.appearance}><App adapter={adapter}/></AppearanceProvider></React.StrictMode>);
