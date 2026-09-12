import type {DesktopConnectionControls} from './connection-controls.js';
import type {DesktopTelegramSetup} from './telegram-setup.js';
import {WorkAttachmentError} from './work-attachments.js';
import type {DesktopWorkControls} from './work-controls.js';
import type {WorkPins} from './work-pins.js';
import type{DesktopModelSetup}from'./model-setup.js';
import{validAppearance}from'../shared/appearance.js';
import type{AppearanceSettings}from'./appearance-store.js';
import { ipcMain, type BrowserWindow } from 'electron';
import { CONTROL_METHODS,CONTROL_EVENTS,validateControlRequest,exactKeys, isControlId, isRecord } from '@estacoda/control-protocol';
import type { DesktopSnapshot } from '../shared/desktop-api.js';
import type { DesktopConnection, ConnectionState } from './connection.js';
import { WindowAuthority } from './window-policy.js';
import type { Profiles } from './profiles.js';
export function rendererSnapshot(state:ConnectionState):DesktopSnapshot {
  return {counts:state.status==='ready'?state.counts??null:null,status:state.status,profile:state.bootstrap?.profile??{id:state.profileId,label:state.profileId,configuration:'unconfigured'},runtime:state.bootstrap?.runtime.state??'disconnected',work:state.work,inbox:state.inbox};
}
export function validateSemanticPayload(method:string,payload:unknown):void {
  if(!isRecord(payload))throw new Error('Desktop request rejected.');
  if((method==='workInspect'||method==='workLive'||method==='workUsage')){if(!exactKeys(payload,['workId'])||!isControlId(payload.workId))throw new Error('Invalid Work');return;}
  if(method==='workDecide'||method==='workInspectDecision'){if(!exactKeys(payload,method==='workDecide'?['itemId','decision']:['itemId'])||!isControlId(payload.itemId)||method==='workDecide'&&!['approved','denied'].includes(String(payload.decision)))throw new Error('Invalid approval decision');return;}
  if(method==='workAct'){if(!exactKeys(payload,['workId','action'],['stepId','guidance'])||!isControlId(payload.workId)||!['sessions.resume','sessions.cancelTurn','tasks.pause','tasks.resume','tasks.cancel','tasks.retry','tasks.guide'].includes(String(payload.action))||payload.stepId!==undefined&&!isControlId(payload.stepId)||payload.guidance!==undefined&&(typeof payload.guidance!=='string'||payload.guidance.length<1||payload.guidance.length>4000)||payload.action==='tasks.guide'&&typeof payload.guidance!=='string')throw new Error('Invalid Work action');return;}
  if(method==='workAttach'||method==='workSubmit'){
    if(!exactKeys(payload,method==='workAttach'?['draftId','target']:['draftId','target','text','attachmentIds'],method==='workAttach'?[]:['workId','selection','kind','limits'])||!isControlId(payload.draftId)||!isRecord(payload.target)||!exactKeys(payload.target,['targetId','targetGeneration'])||!isControlId(payload.target.targetId)||!Number.isSafeInteger(payload.target.targetGeneration)||Number(payload.target.targetGeneration)<1)throw new Error('Invalid Work input');
    if(method==='workSubmit'){
      if(typeof payload.text!=='string'||payload.text.length>32768||!Array.isArray(payload.attachmentIds)||payload.attachmentIds.length>4||!payload.attachmentIds.every(isControlId)||payload.workId!==undefined&&!isControlId(payload.workId))throw new Error('Invalid prompt');
      if(payload.kind!==undefined&&!['session','task'].includes(String(payload.kind)))throw new Error('Invalid Work kind');
      if(payload.limits!==undefined){const limits=payload.limits;if(!isRecord(limits)||!exactKeys(limits,['maxProviderCalls','maxTotalTokens','maxWallClockMs'])||!Object.entries({maxProviderCalls:45,maxTotalTokens:1000000,maxWallClockMs:1800000}).every(([key,max])=>Number.isSafeInteger(limits[key])&&Number(limits[key])>=1&&Number(limits[key])<=max))throw new Error('Invalid Task limits');}
      if(payload.selection!==undefined)validateSemanticPayload('setOverride',{workId:'validation',selection:payload.selection});
    }return;
  }
  if(method==='workSearch'){if(!exactKeys(payload,['query'],['cursor'])||typeof payload.query!=='string'||payload.query.length>200||payload.cursor!==undefined&&(typeof payload.cursor!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(payload.cursor)))throw new Error('Invalid search');return;}
  if(method==='workPin'){if(!exactKeys(payload,['workId','pinned'])||!isControlId(payload.workId)||typeof payload.pinned!=='boolean')throw new Error('Invalid pin');return;}
  if(['workOverride','inspectOverride','setOverride'].includes(method)){if(!exactKeys(payload,method==='setOverride'?['workId','selection']:['workId'])||!isControlId(payload.workId))throw new Error('Invalid Work');if(method==='setOverride'&&payload.selection!==null){const s=payload.selection;if(!isRecord(s)||!exactKeys(s,['providerId','modelId'])||!isControlId(s.providerId)||typeof s.modelId!=='string'||!s.modelId.length||s.modelId.length>200)throw new Error('Invalid model');}return;}
  if(method==='setupVerifyReviewed'){if(!exactKeys(payload,['setupId','allowPrivateEndpoint'])||!isControlId(payload.setupId)||typeof payload.allowPrivateEndpoint!=='boolean')throw new Error('Invalid verification');return;}
  if(['setupConfigured','setupOrder','setupMode'].includes(method)){validateControlRequest({jsonrpc:'2.0',id:'validation',method:method==='setupConfigured'?'models.reviewConfigured':method==='setupOrder'?'models.reviewFallbackOrder':'models.reviewAuxiliaryMode',params:{...payload,windowId:'validation',generation:1}},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});if('windowId' in payload||'generation' in payload)throw new Error('Invalid setup authority');return;}
  if(method==='setupReview'){if(!exactKeys(payload,['setupId'],['role'])||!isControlId(payload.setupId))throw new Error('Invalid review');if(payload.role!==undefined){const role=payload.role;if(!isRecord(role)||!exactKeys(role,['role'],['slot','fallbackToMain'])||!['primary','fallback','auxiliary'].includes(String(role.role))||role.role==='auxiliary'&&(!['assessor','compression','session_search','memory_compaction','profile_context'].includes(String(role.slot))||typeof role.fallbackToMain!=='boolean')||role.role!=='auxiliary'&&('slot' in role||'fallbackToMain' in role))throw new Error('Invalid route role');}return;}
  if(method==='gatewayExecute'){if(!exactKeys(payload,['action','acknowledgeSharedWork'])||!['install','start','stop','restart'].includes(String(payload.action))||payload.acknowledgeSharedWork!==true)throw new Error('Invalid gateway action');return;}
  if(method==='telegramReview'){if(!exactKeys(payload,['setupId','settings'])||!isControlId(payload.setupId))throw new Error('Invalid Telegram review.');validateControlRequest({jsonrpc:'2.0',id:'validation',method:'telegram.review',params:{windowId:'validation',generation:1,settings:payload.settings}},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  if(method==='setupBegin'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:'models.validateRoute',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  const valid=['telegramApply','telegramStage','telegramVerify','telegramCancel','setupOAuthStart','setupOAuthStatus','setupOAuthOpen','setupStage','setupVerify','setupReview','setupApply','setupCancel'].includes(method)?exactKeys(payload,['setupId'])&&isControlId(payload.setupId):['modelPage','providerPage'].includes(method)?exactKeys(payload,[],['cursor'])&&(payload.cursor===undefined||typeof payload.cursor==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(payload.cursor)):method==='setAppearance'?validAppearance(payload):method==='getWork'?exactKeys(payload,['workId'])&&isControlId(payload.workId):(method==='activity'||method==='workChildren')?exactKeys(payload,['workId'],['cursor'])&&isControlId(payload.workId)&&(payload.cursor===undefined||typeof payload.cursor==='string'&&payload.cursor.length<=2048)
    :method==='switchProfile'?exactKeys(payload,['id'])&&isControlId(payload.id):exactKeys(payload,[]);
  if(!valid)throw new Error('Desktop request rejected.');
}
export function installSemanticIpc(window:BrowserWindow,documentUrl:string,connection:DesktopConnection,profiles:Profiles,appearance:AppearanceSettings,models?:DesktopModelSetup,pins?:WorkPins,workControls?:DesktopWorkControls,telegram?:DesktopTelegramSetup,connectionControls?:DesktopConnectionControls):()=>void {
  const authority=new WindowAuthority(window,documentUrl);
  const contents=window.webContents;
  const methods=['gatewayDiagnostics','gatewayExecute','connectionInspect','telegramReview','telegramApply','telegramInspectApply','telegramBegin','telegramStage','telegramVerify','telegramCancel','connectionsList','workUsage','workDecide','workInspectDecision','workAct','workChildren','workLive','workTargets','workAttach','workSubmit','workInspect','workSearch','workPins','workPin','workOverride','setOverride','inspectOverride','setupVerifyReviewed','modelRoutes','setupConfigured','setupOrder','setupMode','setupOAuthStart','setupOAuthStatus','setupOAuthOpen','setupBegin','setupStage','setupVerify','setupReview','setupApply','setupCancel','setupInspect','modelPage','providerPage','refreshCatalog','reconnect','moreWork','moreInbox','appearance','setAppearance','snapshot','getWork','activity','profiles','switchProfile','minimize','toggleMaximize','close'];
  const handlers:string[]=[];
  let connectionGeneration=connection.state.generation;
  const state=(value:ConnectionState)=>{if(value.generation!==connectionGeneration){authority.invalidate();connectionGeneration=value.generation;}if(!window.isDestroyed())contents.send('desktop:state',{generation:authority.generation,snapshot:rendererSnapshot(value)});};
  connection.on('state',state);
  for(const method of methods){
    const channel='desktop:'+method;handlers.push(channel);
    ipcMain.handle(channel,async(event,envelope:unknown)=>{
      if(!isRecord(envelope)||!exactKeys(envelope,['generation','payload'])||!Number.isSafeInteger(envelope.generation))throw new Error('Desktop request rejected.');
      authority.assertSender(event,Number(envelope.generation));validateSemanticPayload(method,envelope.payload);
      const payload=envelope.payload as Record<string,unknown>;
      const generation=authority.generation;
      try {
        if(method==='workDecide'||method==='workInspectDecision'){if(!workControls)throw new Error('Work unavailable');const result=method==='workDecide'?await workControls.decide(payload.itemId as string,payload.decision as 'approved'|'denied'):await workControls.inspectDecision(payload.itemId as string);authority.assertSender(event,generation);return result;}
        if(method==='workAct'){if(!workControls)throw new Error('Work unavailable');const result=await workControls.act(payload as Parameters<DesktopWorkControls['act']>[0]);authority.assertSender(event,generation);return result;}
        if(method==='workChildren'){await connection.getWork(payload.workId as string);authority.assertSender(event,generation);const result=await connection.search('',payload.cursor as string|undefined,payload.workId as string);authority.assertSender(event,generation);return result;}
        if(method==='workLive'||method==='workUsage'){const result=await connection.workRequest(method==='workLive'?'work.live':'work.usage',{workId:payload.workId as string});authority.assertSender(event,generation);return result;}
        if(['workTargets','workAttach','workSubmit','workInspect'].includes(method)){
          if(!workControls)throw new Error('Work unavailable');
          const result=method==='workTargets'?await connection.workRequest('work.targets',{}):method==='workAttach'?await workControls.attach(payload as Parameters<DesktopWorkControls['attach']>[0]):method==='workSubmit'?await workControls.submit(payload as Parameters<DesktopWorkControls['submit']>[0]):await workControls.inspect(payload.workId as string);
          authority.assertSender(event,generation);return result;
        }
        if(method==='workSearch'||method==='workPins'||method==='workPin'){
          const result=method==='workSearch'?await connection.search(payload.query as string,payload.cursor as string|undefined):method==='workPin'?await pins?.set(payload.workId as string,payload.pinned as boolean):await pins?.list();
          authority.assertSender(event,generation);if(!result)throw new Error('Work unavailable');return result;
        }
        if(['workOverride','setOverride','inspectOverride'].includes(method)){if(!models)throw new Error('Models unavailable');const result=method==='workOverride'?await models.workOverride(payload.workId as string):method==='setOverride'?await models.setOverride(payload.workId as string,payload.selection as {providerId:string;modelId:string}|null):await models.inspectOverride(payload.workId as string);authority.assertSender(event,generation);return result;}
        if(['gatewayDiagnostics','gatewayExecute','connectionInspect'].includes(method)){if(!connectionControls)throw new Error('Connections unavailable');const result=method==='gatewayDiagnostics'?await connection.connectionRequest('gateway.diagnostics',{}):method==='connectionInspect'?await connectionControls.inspect():await connectionControls.gateway(payload.action as Parameters<DesktopConnectionControls['gateway']>[0]);authority.assertSender(event,generation);return result;}
        if(['telegramReview','telegramApply','telegramInspectApply'].includes(method)){if(!telegram)throw new Error('Telegram unavailable.');const result=method==='telegramReview'?await telegram.review(payload.setupId as string,payload.settings as Parameters<DesktopTelegramSetup['review']>[1]):method==='telegramApply'?await telegram.apply(payload.setupId as string):await telegram.inspect();authority.assertSender(event,generation);return result;}
        if(['telegramBegin','telegramStage','telegramVerify','telegramCancel'].includes(method)){if(!telegram)throw new Error('Telegram unavailable.');const result=method==='telegramBegin'?await telegram.begin():method==='telegramStage'?await telegram.stage(payload.setupId as string):method==='telegramVerify'?await telegram.verify(payload.setupId as string):await telegram.cancel(payload.setupId as string);authority.assertSender(event,generation);return result;}
        if(method==='connectionsList'){const result=await connection.connectionRequest('connections.list',{limit:100});authority.assertSender(event,generation);return result;}
        if(method==='modelRoutes'){if(!models)throw new Error('Models unavailable');const result=await models.routes();authority.assertSender(event,generation);return result;}
        if(method.startsWith('setup')){if(!models)throw new Error('Setup unavailable.');const result=method==='setupVerifyReviewed'?await models.verifyReviewed(payload.setupId as string,payload.allowPrivateEndpoint as boolean):method==='setupConfigured'?await models.reviewed('models.reviewConfigured',payload as any):method==='setupOrder'?await models.reviewed('models.reviewFallbackOrder',payload as any):method==='setupMode'?await models.reviewed('models.reviewAuxiliaryMode',payload as any):method==='setupOAuthStart'?await models.oauthStart(payload.setupId as string):method==='setupOAuthStatus'?await models.oauthStatus(payload.setupId as string):method==='setupOAuthOpen'?await models.oauthOpen(payload.setupId as string):method==='setupBegin'?await models.begin(payload.route as Parameters<DesktopModelSetup['begin']>[0]):method==='setupStage'?await models.stage(payload.setupId as string):method==='setupVerify'?await models.verify(payload.setupId as string):method==='setupReview'?await models.review(payload.setupId as string,payload.role as Parameters<DesktopModelSetup['review']>[1]):method==='setupApply'?await models.apply(payload.setupId as string):method==='setupCancel'?await models.cancel(payload.setupId as string):await models.inspect();authority.assertSender(event,generation);return result;}
        if(method==='modelPage'||method==='providerPage'||method==='refreshCatalog'){const result=method==='refreshCatalog'?await connection.modelRequest('models.refreshCatalog',{networkApproved:true}):await connection.modelRequest(method==='modelPage'?'models.list':'providers.list',{limit:100,...(payload.cursor?{cursor:payload.cursor as string}:{})});authority.assertSender(event,generation);return result;}
        if(method==='reconnect'){connection.switchProfile(connection.state.profileId);return;}
        if(method==='moreWork'||method==='moreInbox'){await connection.more(method==='moreWork'?'work':'inbox');authority.assertSender(event,generation);return;}
        if(method==='appearance')return appearance.read();
        if(method==='setAppearance'){appearance.write(payload);return;}
        if(method==='snapshot')return rendererSnapshot(connection.state);
        if(method==='profiles')return profiles.list();
        if(method==='switchProfile'){profiles.assertSelectable(payload.id);connection.switchProfile(payload.id);return;}
        if(method==='minimize'){window.minimize();return;}
        if(method==='toggleMaximize'){window.isMaximized()?window.unmaximize():window.maximize();return;}
        if(method==='close'){window.close();return;}
        const result=method==='getWork'?await connection.getWork(payload.workId as string):await connection.activity(payload.workId as string,payload.cursor as string|undefined);
        authority.assertSender(event,generation);return result;
      }catch(error){if(error instanceof WorkAttachmentError)throw new Error(error.message);throw new Error('Desktop operation unavailable.');}
    });
  }
  // Used only by sandboxed preload to obtain its first Main-owned binding.
  ipcMain.handle('desktop:bind',event=>{authority.assertSender(event,authority.generation);return{generation:authority.generation,snapshot:rendererSnapshot(connection.state)};});
  let loaded=false;
  const navigation=(_event:unknown,url:string,isInPlace:boolean,isMainFrame:boolean)=>{if(loaded&&isMainFrame&&!isInPlace&&url===documentUrl){authority.invalidate();connection.close();}};
  const finished=()=>{if(loaded)connection.switchProfile(connection.state.profileId);loaded=true;};
  contents.on('did-start-navigation',navigation);contents.on('did-finish-load',finished);
  return()=>{authority.invalidate();connection.off('state',state);for(const channel of [...handlers,'desktop:bind'])ipcMain.removeHandler(channel);contents.off('did-start-navigation',navigation).off('did-finish-load',finished);};
}
