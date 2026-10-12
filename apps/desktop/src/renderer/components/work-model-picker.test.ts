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
it('retains compact attribution and expandable fallback details without warning banners',()=>{
 const item:ActivityProjection={id:'route',workId:'session:s',profileId:'p',timestamp:1,sequence:0,kind:'model',executionModel:model};
 const render=(items:ActivityProjection[])=>renderToStaticMarkup(createElement(CanonicalActivity,{items,results:()=>{}})).replace(/[\u2068\u2069]/g,'');
 expect(render([item])).toContain('Answered with gpt-5.5');
 expect(render([item])).toContain('Response details');
 expect(render([item])).not.toContain('ec-activitynotice');
 const trying=render([{...item,executionModel:{...model,state:'attempting'}}]);
 expect(trying).toContain('Trying gpt-5.5');expect(trying).not.toContain('Continuing with');
 expect(render([{...item,executionModel:{...model,state:'failed'}}])).toContain('Model attempt failed: gpt-5.5');
});

it('keeps partial routing recovery behind details and shows full fallback once',()=>{
 const base={workId:'session:s',profileId:'p',timestamp:1,sequence:0};
 const routing:ActivityProjection={...base,id:'r1',kind:'routing',routing:{stage:'intent-skills',configuredMode:'jev-assisted',actualEngine:'jev',partialFallback:true,fallbackReason:'uncertain'}};
 const render=(items:ActivityProjection[])=>renderToStaticMarkup(createElement(CanonicalActivity,{items,results:()=>{}}));
 const partial=render([routing]);
 expect(partial).not.toContain('ec-activitynotice');
 expect(partial).not.toContain('ec-run-history');
 expect(partial).toContain('partial Standard fallback');
 expect(partial).not.toContain('Standard routing used');
 const full=render([{...routing,routing:{...routing.routing,actualEngine:'standard',partialFallback:undefined}},{...routing,id:'r2',routing:{...routing.routing,stage:'capabilities',actualEngine:'standard'}}]);
 expect(full.match(/Standard routing used/g)).toHaveLength(1);
 expect(full).not.toContain('ec-activitynotice');
});
it('settled completion suppresses recovered status warnings; unresolved outcomes have one notice',()=>{
 const base={workId:'session:s',profileId:'p',timestamp:1,sequence:0};
 const status:ActivityProjection={...base,id:'s1',kind:'status',status:'needs_attention',reason:'Earlier problem'};
 const result:ActivityProjection={...base,id:'result',kind:'result',status:'completed',evidence:{state:'unverified',summary:'Done',artifactIds:[]},usage:{reportedTokens:null,cost:null}};
 const render=(items:ActivityProjection[])=>renderToStaticMarkup(createElement(CanonicalActivity,{items,results:()=>{}}));
 expect(render([status,result])).not.toContain('ec-activitynotice');
 expect(render([result,{...status,status:'paused',reason:'Approval required'}])).toContain('Approval required');
 expect(render([status,{...result,status:'needs_attention'}]).match(/class="ec-activitynotice"/g)).toHaveLength(1);
});
