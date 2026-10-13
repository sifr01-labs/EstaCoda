import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WorkModelPicker} from './work-model-picker.js';
import {ResponseDetails,responseModelGroups} from './response-details.js';
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
 expect(render([item])).toContain('Call completed');
 expect(render([item])).not.toContain('Answered with');
 expect(render([item])).toContain('Response details');
 expect(render([item])).not.toContain('ec-activitynotice');
 const trying=render([{...item,executionModel:{...model,state:'attempting'}}]);
 expect(trying).toContain('Call started');expect(trying).not.toContain('Continuing with');
 expect(render([{...item,executionModel:{...model,state:'failed'}}])).toContain('Call failed');
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

it('attributes the response once and preserves successful tool calls as calls',()=>{
 const base={workId:'session:s',profileId:'p',timestamp:1,sequence:0,kind:'model' as const};
 const items:Extract<ActivityProjection,{kind:'model'}>[]=[
  {...base,id:'p1',executionModel:{providerId:'primary',modelId:'kimi',fallback:false,state:'attempting'}},
  {...base,id:'p2',executionModel:{providerId:'primary',modelId:'kimi',fallback:false,state:'failed'}},
  {...base,id:'f1',executionModel:{...model,state:'attempting'}},
  {...base,id:'f2',executionModel:model},
  {...base,id:'f3',executionModel:{...model,state:'attempting'}},
  {...base,id:'f4',executionModel:model},
 ];
 expect(responseModelGroups(items).map(group=>group.records.length)).toEqual([2,4]);
 const render=(active:boolean,answered:boolean)=>renderToStaticMarkup(createElement(ResponseDetails,{items,active,answered}));
 const html=render(false,true).replace(/[\u2068\u2069]/g,'');
 expect(html.match(/Answered by/g)).toHaveLength(1);expect(html.match(/Call completed/g)).toHaveLength(2);
 expect(html).toContain('Completed calls: 2');expect(html).toContain('Failed calls: 1');
 expect(html).not.toContain('Answered with');expect(html).not.toContain('rate limit');
 expect(render(true,true)).not.toContain('Answered by');expect(render(false,false)).not.toContain('Answered by');
 const failedAfterTools=renderToStaticMarkup(createElement(ResponseDetails,{items:[...items,{...items[5]!,id:'failed-final',executionModel:{...model,state:'failed'}}],active:false,answered:true}));
 expect(failedAfterTools).not.toContain('Answered by');expect(failedAfterTools).toContain('Last recorded model');
 // Identical model IDs from distinct providers keep independent histories.
 expect(responseModelGroups([...items,{...items[5]!,id:'other',executionModel:{...model,providerId:'other'}}])).toHaveLength(3);
});
