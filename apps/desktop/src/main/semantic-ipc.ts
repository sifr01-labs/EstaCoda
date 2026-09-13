import {DesktopMicrophone} from './desktop-microphone.js';
import {setMicrophonePermission} from './window-policy.js';
import {readDesktopMedia,saveDesktopMedia} from './desktop-media-output.js';
import type {DesktopPublicSettings} from './public-settings.js';
import {validateHumanBrowserCommand,validateBrowserWorkspaceAction,validateHumanBrowserInput} from '@estacoda/control-protocol';
import type {DesktopBrowserControls} from './browser-controls.js';
import type {DesktopTerminalControls} from './terminal-controls.js';
import type {DesktopTargetControls} from './target-controls.js';
import type {DesktopConnectionControls} from './connection-controls.js';
import type {DesktopTelegramSetup} from './telegram-setup.js';
import {WorkAttachmentError} from './work-attachments.js';
import type {DesktopWorkControls} from './work-controls.js';
import type {WorkPins} from './work-pins.js';
import type{DesktopModelSetup}from'./model-setup.js';
import{validAppearance}from'../shared/appearance.js';
import type{AppearanceSettings}from'./appearance-store.js';
import { app,systemPreferences,dialog,ipcMain, type BrowserWindow } from 'electron';
import { CONTROL_METHODS,CONTROL_EVENTS,validateControlRequest,exactKeys, isControlId, isRecord } from '@estacoda/control-protocol';
import type { DesktopSnapshot } from '../shared/desktop-api.js';
import type { DesktopConnection, ConnectionState } from './connection.js';
import { WindowAuthority } from './window-policy.js';
import type { Profiles } from './profiles.js';
export function rendererSnapshot(state:ConnectionState):DesktopSnapshot {
  return {counts:state.status==='ready'?state.counts??null:null,status:state.status,profile:state.bootstrap?.profile??{id:state.profileId,label:state.profileId,configuration:'unconfigured'},runtime:state.bootstrap?.runtime.state??'disconnected',work:state.work,inbox:state.inbox};
}
export function validateSemanticPayload(method:string,payload:unknown):void {
 if(method.startsWith('record')){if(!isRecord(payload))throw new Error('Invalid recording request');if(method==='recordBegin'){if(!exactKeys(payload,['draftId','target'])||!isControlId(payload.draftId))throw new Error('Invalid recording scope');validateControlRequest({jsonrpc:'2.0',id:'v',method:'work.targets',params:{target:payload.target}},{profileId:'v',instanceId:'v',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}if(!['recordAppend','recordFinish','recordCancel'].includes(method)||!isControlId(payload.id)||!exactKeys(payload,method==='recordAppend'?['id','data']:['id'])||method==='recordAppend'&&(typeof payload.data!=='string'||payload.data.length>32768))throw new Error('Invalid recording request');return;}
 if(method.startsWith('settings')){
  if(!isRecord(payload))throw new Error('Invalid settings request.');
  const context={profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}};
  if(method==='settingsWorkspaces'){if(!exactKeys(payload,[]))throw new Error('Invalid workspace request.');return;}
  if(method==='settingsReviewAction'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:'settings.reviewAction',params:payload},context);return;}
  if(method==='settingsExecuteAction'||method==='settingsCancelAction'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:method==='settingsExecuteAction'?'settings.executeAction':'settings.cancelAction',params:method==='settingsExecuteAction'?{...payload,operationId:'main'}:payload},context);return;}
  if(method==='settingsLifecycle'||method==='settingsDependencies' ||method==='settingsInspectDependency'){if(!exactKeys(payload,[]))throw new Error('Invalid dependency request.');return;}
  if(method==='settingsInstall'){if(!exactKeys(payload,['capabilityId','groups','downloadApproved']))throw new Error('Invalid dependency request.');validateControlRequest({jsonrpc:'2.0',id:'validation',method:'settings.installDependency',params:{...payload,operationId:'main'}},context);return;}
  if(method==='settingsValue'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:'settings.value',params:payload},context);return;}
  if(method==='settingsRead'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:'settings.read',params:payload},context);return;}
  if(['settingsBegin','settingsInspect','settingsVerify'].includes(method)){if(!exactKeys(payload,[]))throw new Error('Invalid settings request.');return;}
  if(!isControlId(payload.setupId)||!exactKeys(payload,method==='settingsReview'?['setupId','changes']:method==='settingsStage'?['setupId','fieldId','selectors']:['setupId']))throw new Error('Invalid settings request.');
  if(method==='settingsReview'||method==='settingsStage')validateControlRequest({jsonrpc:'2.0',id:'validation',method:'settings.review',params:{windowId:'main',generation:1,changes:method==='settingsReview'?payload.changes:[{fieldId:payload.fieldId,selectors:payload.selectors,value:'staged'}]}},context);
  else if(!['settingsApply','settingsCancel'].includes(method))throw new Error('Invalid settings request.');return;
 }

  if(method==='browserControlWatch'){if(!isRecord(payload)||!exactKeys(payload,['workId','browserId']))throw new Error('Invalid browser observation.');validateSemanticPayload('browserList',{workId:payload.workId});validateHumanBrowserCommand({action:'watch',holder:'main',browserId:payload.browserId});return;}
  if(method==='browserControlSignIn'){if(!isRecord(payload)||!isControlId(payload.id)||!exactKeys(payload,['id','frameId','submitRef','kind']))throw new Error('Invalid protected entry.');validateHumanBrowserCommand({action:'signin-prepare',holder:'main',browserId:'main',lease:{id:'main',generation:1},sequence:1,frameId:payload.frameId,submitRef:payload.submitRef,kind:payload.kind});return;}
  if(method==='browserControlInventory'||method==='browserControlWorkspaceOpen'){validateSemanticPayload('browserList',payload);return;}
  if(method==='browserControlWorkspace'){if(!isRecord(payload)||!isControlId(payload.id)||!exactKeys(payload,['id','operation']))throw new Error('Invalid browser workspace request.');validateBrowserWorkspaceAction(payload.operation);return;}
  if(method==='browserControlOpen'){validateSemanticPayload('browserSnapshot',payload);return;}
  if(['browserControlFrame','browserControlRelease','browserControlAbandon'].includes(method)){
    if(!isRecord(payload)||!isControlId(payload.id)||!exactKeys(payload,['id'],method==='browserControlFrame'?['input']:[]))throw new Error('Invalid browser handle.');
    if(payload.input!==undefined)validateHumanBrowserInput(payload.input);return;
  }
  if(method==='browserList'||method==='browserSnapshot'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:method==='browserList'?'browser.list':'browser.snapshot',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  if(method.startsWith('terminal')){
    if(method==='terminalOpen'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:'terminal.acquire',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
    if(!isRecord(payload)||!exactKeys(payload,method==='terminalWrite'?['id','data']:method==='terminalResize'?['id','cols','rows']:['id'])||!isControlId(payload.id)||!['terminalRead','terminalWrite','terminalResize','terminalClose'].includes(method))throw new Error('Invalid terminal input.');
    if(method==='terminalWrite'&&(typeof payload.data!=='string'||payload.data.length<1||payload.data.length>4096))throw new Error('Terminal input exceeds limit.');
    if(method==='terminalResize'&&(!Number.isSafeInteger(payload.cols)||!Number.isSafeInteger(payload.rows)||Number(payload.cols)<2||Number(payload.cols)>400||Number(payload.rows)<2||Number(payload.rows)>200))throw new Error('Invalid terminal size.');return;
  }
  if(method==='artifactsMedia'||method==='artifactsSave'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:'artifacts.mediaBegin',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
 if(['artifactsList','artifactsGet','artifactsOpen','evidenceGet'].includes(method)){validateControlRequest({jsonrpc:'2.0',id:'validation',method:method==='artifactsList'?'artifacts.list':method==='artifactsGet'?'artifacts.get':method==='artifactsOpen'?'artifacts.open':'evidence.get',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  if(method==='diffList'||method==='diffPatch'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:method==='diffList'?'diff.list':'diff.patch',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  if(method==='filesList'||method==='filesPreview'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:method==='filesList'?'files.list':'files.preview',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  if(method==='workTargets'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:'work.targets',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  if(method.startsWith('target')){
    const mapping:Record<string,string>={targetList:'targets.list',targetInspect:'targets.inspect',targetReview:'targets.reviewCreate',targetCancel:'targets.cancelReview',targetExecute:'targets.execute',targetOperation:'targets.list'};
    if(method==='targetCreate'){if(!isRecord(payload)||!exactKeys(payload,['reviewId','trustNewPath'])||!isControlId(payload.reviewId)||payload.trustNewPath!==true)throw new Error('Invalid target creation');return;}
    if(!isRecord(payload)||'operationId' in payload||!mapping[method])throw new Error('Invalid target operation');
    validateControlRequest({jsonrpc:'2.0',id:'validation',method:mapping[method],params:method==='targetExecute'?{...payload,operationId:'validation'}:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;
  }
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
  if(method==='telegramExecute'){if(!exactKeys(payload,['action','confirmed'],['destination'])||!['pairingCreate','pairingCancel','sync','test'].includes(String(payload.action))||payload.confirmed!==true||payload.destination!==undefined&&(typeof payload.destination!=='string'||!/^\-?\d{1,20}$/.test(payload.destination)))throw new Error('Invalid Telegram action');return;}
  if(method==='telegramDetails'||method==='telegramHandoff'){if(!exactKeys(payload,method==='telegramDetails'?['workId']:['workId','action','confirmed'],method==='telegramDetails'?[]:['attachmentId'])||!isControlId(payload.workId)||method==='telegramHandoff'&&(!['create','revoke','detach'].includes(String(payload.action))||payload.confirmed!==true||payload.attachmentId!==undefined&&(typeof payload.attachmentId!=='string'||payload.attachmentId.length>512)))throw new Error('Invalid handoff');return;}
  if(method==='gatewayExecute'){if(!exactKeys(payload,['action','acknowledgeSharedWork'])||!['install','start','stop','restart'].includes(String(payload.action))||payload.acknowledgeSharedWork!==true)throw new Error('Invalid gateway action');return;}
  if(method==='telegramReview'){if(!exactKeys(payload,['setupId','settings'])||!isControlId(payload.setupId))throw new Error('Invalid Telegram review.');validateControlRequest({jsonrpc:'2.0',id:'validation',method:'telegram.review',params:{windowId:'validation',generation:1,settings:payload.settings}},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  if(method==='setupBegin'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:'models.validateRoute',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  const valid=['telegramApply','telegramStage','telegramVerify','telegramCancel','setupOAuthStart','setupOAuthStatus','setupOAuthOpen','setupStage','setupVerify','setupReview','setupApply','setupCancel'].includes(method)?exactKeys(payload,['setupId'])&&isControlId(payload.setupId):['modelPage','providerPage'].includes(method)?exactKeys(payload,[],['cursor'])&&(payload.cursor===undefined||typeof payload.cursor==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(payload.cursor)):method==='setAppearance'?validAppearance(payload):method==='getWork'?exactKeys(payload,['workId'])&&isControlId(payload.workId):(method==='activity'||method==='workChildren')?exactKeys(payload,['workId'],['cursor'])&&isControlId(payload.workId)&&(payload.cursor===undefined||typeof payload.cursor==='string'&&payload.cursor.length<=2048)
    :method==='switchProfile'?exactKeys(payload,['id'])&&isControlId(payload.id):exactKeys(payload,[]);
  if(!valid)throw new Error('Desktop request rejected.');
}
export function installSemanticIpc(window:BrowserWindow,documentUrl:string,connection:DesktopConnection,profiles:Profiles,appearance:AppearanceSettings,models?:DesktopModelSetup,pins?:WorkPins,workControls?:DesktopWorkControls,telegram?:DesktopTelegramSetup,connectionControls?:DesktopConnectionControls,targets?:DesktopTargetControls,terminals?:DesktopTerminalControls,browsers?:DesktopBrowserControls,settings?:DesktopPublicSettings):()=>void {
  const authority=new WindowAuthority(window,documentUrl);
  const contents=window.webContents;
  const microphone=workControls?new DesktopMicrophone(connection,app.getPath('temp'),()=>process.platform==='darwin'?systemPreferences.askForMediaAccess('microphone'):Promise.resolve(true),enabled=>setMicrophonePermission(window,documentUrl,enabled),(scope,path)=>workControls.stageRecording(scope,path)):undefined;
  const methods=['recordBegin','recordAppend','recordFinish','recordCancel','artifactsMedia','artifactsSave','settingsLifecycle','settingsWorkspaces','settingsReviewAction','settingsExecuteAction','settingsCancelAction','settingsDependencies','settingsInstall','settingsInspectDependency','settingsValue','settingsRead','settingsBegin','settingsStage','settingsReview','settingsApply','settingsCancel','settingsInspect','settingsVerify','browserControlWatch','browserControlSignIn','browserControlInventory','browserControlWorkspaceOpen','browserControlWorkspace','browserControlOpen','browserControlFrame','browserControlRelease','browserControlAbandon','browserList','browserSnapshot','artifactsList','artifactsGet','artifactsOpen','evidenceGet','terminalOpen','terminalRead','terminalWrite','terminalResize','terminalClose','diffList','diffPatch','filesList','filesPreview','targetList','targetInspect','targetReview','targetCreate','targetCancel','targetExecute','targetOperation','telegramExecute','telegramPairing','telegramSessions','telegramDetails','telegramHandoff','gatewayDiagnostics','gatewayExecute','connectionInspect','telegramReview','telegramApply','telegramInspectApply','telegramBegin','telegramStage','telegramVerify','telegramCancel','connectionsList','workUsage','workDecide','workInspectDecision','workAct','workChildren','workLive','workTargets','workAttach','workSubmit','workInspect','workSearch','workPins','workPin','workOverride','setOverride','inspectOverride','setupVerifyReviewed','modelRoutes','setupConfigured','setupOrder','setupMode','setupOAuthStart','setupOAuthStatus','setupOAuthOpen','setupBegin','setupStage','setupVerify','setupReview','setupApply','setupCancel','setupInspect','modelPage','providerPage','refreshCatalog','reconnect','moreWork','moreInbox','appearance','setAppearance','snapshot','getWork','activity','profiles','switchProfile','minimize','toggleMaximize','close'];
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
        if(method.startsWith('record')){if(!microphone)throw new Error('Recording unavailable');const result=method==='recordBegin'?await microphone.begin(payload as import('./desktop-microphone.js').CaptureScope):method==='recordAppend'?microphone.append(payload.id as string,payload.data as string):method==='recordFinish'?await microphone.finish(payload.id as string):microphone.cancel(payload.id as string);authority.assertSender(event,generation);return result;}
        if(method.startsWith('settings')){
         if(!settings)throw new Error('Settings unavailable.');
         const result=method==='settingsLifecycle'?await settings.lifecycle():method==='settingsWorkspaces'?await settings.workspaces():method==='settingsReviewAction'?await settings.reviewAction(payload as import('@estacoda/control-protocol').SettingsAction):method==='settingsExecuteAction'?await settings.executeAction(payload.reviewId as string):method==='settingsCancelAction'?await settings.cancelAction(payload.reviewId as string):method==='settingsDependencies'?await settings.dependencies():method==='settingsInstall'?await settings.install(payload.capabilityId as string,payload.groups as string[]):method==='settingsInspectDependency'?await settings.inspectDependency():method==='settingsValue'?await settings.value(payload.fieldId as string,payload.selectors as string[]):method==='settingsRead'?await settings.read(payload.section as import('@estacoda/control-protocol').SettingsSection,payload.offset as number|undefined):method==='settingsBegin'?settings.begin():method==='settingsStage'?await settings.stage(payload.setupId as string,payload.fieldId as string,payload.selectors as string[]):method==='settingsReview'?await settings.review(payload.setupId as string,payload.changes as import('@estacoda/control-protocol').SettingChange[]):method==='settingsApply'?await settings.apply(payload.setupId as string):method==='settingsCancel'?await settings.cancel(payload.setupId as string):method==='settingsInspect'?await settings.inspect():await settings.verify();
         authority.assertSender(event,generation);return result;
        }
        if(method.startsWith('browserControl')){
          if(!browsers)throw new Error('Browser controls unavailable.');
          const result=method==='browserControlWatch'?await browsers.watch(payload.workId as string,payload.browserId as string):method==='browserControlSignIn'?await browsers.signIn(payload.id as string,payload.frameId as string,payload.submitRef as string,payload.kind as 'password'|'one-time-code'):method==='browserControlInventory'?await browsers.inventory(payload.workId as string):method==='browserControlWorkspaceOpen'?await browsers.open(payload.workId as string):method==='browserControlWorkspace'?await browsers.workspace(payload.id as string,payload.operation as import('@estacoda/control-protocol').BrowserWorkspaceAction):method==='browserControlOpen'?await browsers.open(payload.workId as string,payload.reference as import('@estacoda/control-protocol').BrowserViewReference):method==='browserControlFrame'?await browsers.frame(payload.id as string,payload.input as import('@estacoda/control-protocol').HumanBrowserInput|undefined):method==='browserControlRelease'?await browsers.release(payload.id as string):browsers.abandon(payload.id as string);
          authority.assertSender(event,generation);return result;
        }
        if(method==='browserList'||method==='browserSnapshot'){
          const result=method==='browserList'?await connection.inspectionRequest('browser.list',payload as {workId:string}):await connection.inspectionRequest('browser.snapshot',payload as import('@estacoda/control-protocol').MethodContracts['browser.snapshot']['params']);
          authority.assertSender(event,generation);return result;
        }
        if(method==='artifactsMedia'||method==='artifactsSave'){
          const media=await readDesktopMedia(connection,payload.reference as import('@estacoda/control-protocol').ArtifactReference);authority.assertSender(event,generation);
          if(method==='artifactsMedia')return {mimeType:media.meta.mimeType,data:media.content.toString('base64')};
          const result=await dialog.showSaveDialog(window,{defaultPath:media.meta.name.replace(/[\/\\]/g,'_')});authority.assertSender(event,generation);media.check();if(result.canceled||!result.filePath)return {saved:false};await saveDesktopMedia(result.filePath,media.content);return {saved:true};
        }
        if(['artifactsList','artifactsGet','artifactsOpen','evidenceGet'].includes(method)){
          const result=method==='artifactsList'?await connection.inspectionRequest('artifacts.list',payload):method==='evidenceGet'?await connection.inspectionRequest('evidence.get',payload as {workId:string}):await connection.inspectionRequest(method==='artifactsGet'?'artifacts.get':'artifacts.open',payload as import('@estacoda/control-protocol').MethodContracts['artifacts.open']['params']);
          authority.assertSender(event,generation);return result;
        }
        if(method.startsWith('terminal')){
          if(!terminals)throw new Error('Terminal unavailable.');
          const result=method==='terminalOpen'?await terminals.open(payload.target as import('@estacoda/control-protocol').TargetReference):method==='terminalRead'?terminals.read(payload.id as string):method==='terminalWrite'?terminals.write(payload.id as string,payload.data as string):method==='terminalResize'?terminals.resize(payload.id as string,payload.cols as number,payload.rows as number):await terminals.close(payload.id as string);
          authority.assertSender(event,generation);return result;
        }
        if(method==='diffList'||method==='diffPatch'){
          const result=await connection.inspectionRequest(method==='diffList'?'diff.list':'diff.patch',payload as import('@estacoda/control-protocol').MethodContracts['diff.patch']['params']);
          authority.assertSender(event,generation);return result;
        }
        if(method==='filesList'||method==='filesPreview'){
          const result=await connection.inspectionRequest(method==='filesList'?'files.list':'files.preview',payload as import('@estacoda/control-protocol').MethodContracts['files.list']['params']);
          authority.assertSender(event,generation);return result;
        }
        if(method.startsWith('target')){
          if(!targets)throw new Error('Targets unavailable');
          const result=method==='targetList'?await connection.targetRequest('targets.list',payload):method==='targetInspect'?await connection.targetRequest('targets.inspect',{target:payload.target as import('@estacoda/control-protocol').TargetReference}):method==='targetReview'?await targets.review(payload.source as import('@estacoda/control-protocol').TargetReference):method==='targetCreate'?await targets.create(payload.reviewId as string,true):method==='targetCancel'?await targets.cancel(payload.reviewId as string):method==='targetOperation'?await targets.operation():await targets.execute(payload.action as 'archive'|'cleanup',payload.target as import('@estacoda/control-protocol').TargetReference,true);
          authority.assertSender(event,generation);return result;
        }
        if(method==='workDecide' ||method==='workInspectDecision'){if(!workControls)throw new Error('Work unavailable');const result=method==='workDecide'?await workControls.decide(payload.itemId as string,payload.decision as 'approved'|'denied'):await workControls.inspectDecision(payload.itemId as string);authority.assertSender(event,generation);return result;}
        if(method==='workAct'){if(!workControls)throw new Error('Work unavailable');const result=await workControls.act(payload as Parameters<DesktopWorkControls['act']>[0]);authority.assertSender(event,generation);return result;}
        if(method==='workChildren'){await connection.getWork(payload.workId as string);authority.assertSender(event,generation);const result=await connection.search('',payload.cursor as string|undefined,payload.workId as string);authority.assertSender(event,generation);return result;}
        if(method==='workLive'||method==='workUsage'){const result=await connection.workRequest(method==='workLive'?'work.live':'work.usage',{workId:payload.workId as string});authority.assertSender(event,generation);return result;}
        if(['workTargets','workAttach','workSubmit','workInspect'].includes(method)){
          if(!workControls)throw new Error('Work unavailable');
          const result=method==='workTargets'?await connection.workRequest('work.targets',payload):method==='workAttach'?await workControls.attach(payload as Parameters<DesktopWorkControls['attach']>[0]):method==='workSubmit'?await workControls.submit(payload as Parameters<DesktopWorkControls['submit']>[0]):await workControls.inspect(payload.workId as string);
          authority.assertSender(event,generation);return result;
        }
        if(method==='workSearch'||method==='workPins'||method==='workPin'){
          const result=method==='workSearch'?await connection.search(payload.query as string,payload.cursor as string|undefined):method==='workPin'?await pins?.set(payload.workId as string,payload.pinned as boolean):await pins?.list();
          authority.assertSender(event,generation);if(!result)throw new Error('Work unavailable');return result;
        }
        if(['workOverride','setOverride','inspectOverride'].includes(method)){if(!models)throw new Error('Models unavailable');const result=method==='workOverride'?await models.workOverride(payload.workId as string):method==='setOverride'?await models.setOverride(payload.workId as string,payload.selection as {providerId:string;modelId:string}|null):await models.inspectOverride(payload.workId as string);authority.assertSender(event,generation);return result;}
        if(['telegramExecute','telegramPairing','telegramSessions','telegramDetails','telegramHandoff'].includes(method)){if(!connectionControls)throw new Error('Connections unavailable');const result=method==='telegramPairing'?await connection.connectionRequest('telegram.pairing',{}):method==='telegramSessions'?await connection.connectionRequest('telegram.sessions',{}):method==='telegramDetails'?await connectionControls.details(payload.workId as string):method==='telegramExecute'?await connectionControls.telegram(payload.action as Parameters<DesktopConnectionControls['telegram']>[0],payload.destination as string|undefined):await connectionControls.handoff(payload.workId as string,payload.action as 'create'|'revoke'|'detach',payload.attachmentId as string|undefined);authority.assertSender(event,generation);return result;}
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
        if(method==='switchProfile'){profiles.assertSelectable(payload.id);await terminals?.closeCurrent();authority.assertSender(event,generation);connection.switchProfile(payload.id);return;}
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
  return()=>{microphone?.dispose();authority.invalidate();connection.off('state',state);for(const channel of [...handlers,'desktop:bind'])ipcMain.removeHandler(channel);contents.off('did-start-navigation',navigation).off('did-finish-load',finished);};
}
