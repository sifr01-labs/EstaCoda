import{fixtureAdapter}from'./adapter.js';
// Separate build entry. No Electron/preload import, real state, or credentials.
import React from 'react';import{createRoot}from'react-dom/client';
import{AppearanceProvider}from'../renderer/appearance.js';import{App}from'../renderer/app.js';
import{DEFAULT_APPEARANCE,validAppearance}from'../shared/appearance.js';
import '../renderer/styles/tokens.css';import '../renderer/styles/components.css';import '../renderer/styles/native.css';import '../renderer/styles/theme-previews.css';import '../renderer/styles/refinement.css';
const adapter=fixtureAdapter();
// Test-build-only initial appearance; this entry is absent from Forge output.
const query=new URLSearchParams(location.search);
const initial={...DEFAULT_APPEARANCE,theme:query.get('theme')??'kemet',appearance:query.get('mode')??'system',language:query.get('language')??'en'};
if(validAppearance(initial))void adapter.api.setAppearance(initial);
createRoot(document.getElementById('root')!).render(<React.StrictMode><AppearanceProvider store={adapter.appearance}><App adapter={adapter}/></AppearanceProvider></React.StrictMode>);

import '../renderer/styles/models.css';
import '../renderer/styles/media-settings.css';
