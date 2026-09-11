import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrandEye,Wordmark,Topline} from './components/primitives.js';
import './styles/tokens.css';
import './styles/components.css';
import './styles/native.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><div id="ec-branded-workspace" data-theme="kemet" data-appearance="system" data-density="comfortable"><div className="ec-window"><Topline label="New chat"/><main className="ec-workcenter"><div className="ec-newwelcome"><BrandEye/><Wordmark/><p>A place to think clearly and get work done.</p></div></main></div></div></React.StrictMode>);
