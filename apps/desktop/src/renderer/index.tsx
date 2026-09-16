import{liveAdapter}from'./live-adapter.js';
import {AppearanceProvider} from './appearance.js';
import {App} from './app.js';
import React from 'react';
import {createRoot} from 'react-dom/client';
import './styles/tokens.css';
import './styles/components.css';
import './styles/native.css';
import './styles/theme-previews.css';import './styles/refinement.css';
const adapter=liveAdapter();
createRoot(document.getElementById('root')!).render(<React.StrictMode><AppearanceProvider store={adapter.appearance}><App adapter={adapter}/></AppearanceProvider></React.StrictMode>);

import './styles/models.css';
import './styles/media-settings.css';
