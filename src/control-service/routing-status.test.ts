import {expect,it,vi} from 'vitest';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {recordRoutingStatus,routingStatus} from '../runtime/jev/routing-status.js';
import {sessionDisplayEvents} from './session-display-events.js';
import {appendSessionEvents} from './work-projections.js';
import {formatRoutingStatus} from '../contracts/desktop-control/routing.js';
import {renderChannelProgressLabel} from '../channels/activity-labels.js';
import {renderPlainProgressLabel} from '../channels/surface-adapters/channel-progress-label.js';
import {validateControlRequest,CONTROL_METHODS,CONTROL_EVENTS} from '../contracts/desktop-control/index.js';
it('persists safe engine facts for historic/live Desktop and both channel progress surfaces',async()=>{
 const db=new SQLiteSessionDB({path:':memory:'});
 try{const session=await db.createSession({id:'s',profileId:'p'});const onEvent=vi.fn();
 const status=routingStatus('capabilities',{configuredMode:'jev-assisted',actualEngine:'standard',fallbackReason:'authentication',model:'secret/unsafe'});
 await recordRoutingStatus({db,sessionId:'s',turnMessageId:'turn',status,onEvent});
 expect(onEvent).toHaveBeenCalledWith({kind:'routing-status',turnMessageId:'turn',stage:'capabilities',configuredMode:'jev-assisted',actualEngine:'standard',fallbackReason:'authentication'});
 const events=sessionDisplayEvents(db.db,'s');const activity=appendSessionEvents(session,[],events);expect(activity).toHaveLength(1);expect(activity[0]).toMatchObject({kind:'routing',routing:status});expect(activity[0]).not.toHaveProperty('executionModel');
 const event=onEvent.mock.calls[0][0];expect(renderChannelProgressLabel(event)).toContain('Update the key');expect(renderPlainProgressLabel(event)).toBe(formatRoutingStatus(status));expect(renderChannelProgressLabel(event,'ar')).toContain('حدّث المفتاح');
 }finally{db.close();}
});
it('rejects invented status fields without projecting provider content',async()=>{
 const db=new SQLiteSessionDB({path:':memory:'});try{const session=await db.createSession({id:'s',profileId:'p'});await db.appendEvent('s',{kind:'routing-status',stage:'capabilities',configuredMode:'jev-assisted',actualEngine:'standard',fallbackReason:'Bearer secret',model:'private/path',raw:'secret'.repeat(10000)} as never);
 const activity=appendSessionEvents(session,[],sessionDisplayEvents(db.db,'s'));expect(JSON.stringify(activity)).not.toContain('secret');expect(JSON.stringify(activity)).not.toContain('private/path');
 }finally{db.close();}
});
it('requires an explicit matched connection-check consent pair at the RPC boundary',()=>{
 const scope={profileId:'p',instanceId:'b',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}};
 const request=(params:unknown)=>({jsonrpc:'2.0',id:'check',method:'settings.verify',params});
 expect(()=>validateControlRequest(request({}),scope)).not.toThrow();expect(()=>validateControlRequest(request({routing:true,spendApproved:true}),scope)).not.toThrow();
 for(const params of [{routing:true},{spendApproved:true},{routing:true,spendApproved:false},{routing:false,spendApproved:false},{routing:true,spendApproved:true,endpoint:'https://evil.invalid'}])expect(()=>validateControlRequest(request(params),scope)).toThrow();
});

it('projects partial fallback consistently without shipping candidate diagnostics to Desktop',async()=>{
 const db=new SQLiteSessionDB({path:':memory:'});try{
 const session=await db.createSession({id:'partial',profileId:'p'});
 await recordRoutingStatus({db,sessionId:'partial',status:{stage:'capabilities',configuredMode:'jev-assisted',actualEngine:'jev',partialFallback:true,fallbackReason:'billing-rejected',diagnostics:{contacted:true,batches:[],candidates:[{id:'internal-only',questionId:'c0',outcome:'missing',source:'standard'}]}}});
 const activity=appendSessionEvents(session,[],sessionDisplayEvents(db.db,'partial'));
 expect(activity[0]).toMatchObject({kind:'routing',routing:{partialFallback:true,fallbackReason:'billing-rejected'}});
 expect(JSON.stringify(activity)).not.toContain('internal-only');
 if(activity[0].kind==='routing')expect(formatRoutingStatus(activity[0].routing)).toContain('partial Standard fallback');
 }finally{db.close();}
});
