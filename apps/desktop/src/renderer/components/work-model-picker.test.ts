import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WorkModelPicker} from './work-model-picker.js';
import {CanonicalActivity} from './canonical-activity.js';
import type {WorkProjection,ActivityProjection} from '@estacoda/control-protocol';
import type {DesktopModelsApi} from '../../shared/desktop-api.js';
import type {Draft} from '../app.js';
const model={providerId:'fallback',modelId:'gpt-5.5',fallback:true,state:'responded' as const};
const work={id:'session:s',kind:'session',status:'running',executionModelActive:true,modelBinding:{sessionId:'s'},target:{targetId:'t'},executionModel:model} as WorkProjection;
const draft={modelSelection:{providerId:'primary',modelId:'kimi'}} as Draft;
it('shows the actual fallback while running without mutating the preferred selection',()=>{
 const html=renderToStaticMarkup(createElement(WorkModelPicker,{api:{} as DesktopModelsApi,work,draft,change:()=>{throw new Error('Must not change preference');}}));
 expect(html).toContain('gpt-5.5 · Fallback');expect(draft.modelSelection?.modelId).toBe('kimi');
 const idle=renderToStaticMarkup(createElement(WorkModelPicker,{api:{} as DesktopModelsApi,work:{...work,status:'completed'},draft,change:()=>{}}));
 expect(idle).toContain('kimi');expect(idle).not.toContain('gpt-5.5 · Fallback');
 const delegated=renderToStaticMarkup(createElement(WorkModelPicker,{api:{} as DesktopModelsApi,work:{...work,executionModelActive:false},draft,change:()=>{}}));
 expect(delegated).toContain('kimi');expect(delegated).not.toContain('gpt-5.5 · Fallback');
});
it('renders a visible durable notice for fallback attempts and success',()=>{
 const item:ActivityProjection={id:'route',workId:'session:s',profileId:'p',timestamp:1,sequence:0,kind:'model',executionModel:model};
 const render=(items:ActivityProjection[])=>renderToStaticMarkup(createElement(CanonicalActivity,{items,results:()=>{}})).replace(/[\u2068\u2069]/g,'');
 expect(render([item])).toContain('Continuing with gpt-5.5 as the fallback model.');
 const trying=render([{...item,executionModel:{...model,state:'attempting'}}]);
 expect(trying).toContain('Trying gpt-5.5.');expect(trying).not.toContain('Continuing with');
 expect(render([{...item,executionModel:{...model,state:'failed'}}])).toContain('could not complete');
});
