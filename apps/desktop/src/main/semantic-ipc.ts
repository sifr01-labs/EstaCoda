import {desktopUpdates} from './updates/service.js';
import {InstallWelcome} from './install-welcome.js';
import {ChatPresentationStore} from './chat-presentation.js';
import {validChatPresentation} from '../shared/chat-presentation.js';
import type {DesktopWorkInput} from './work-secure-input.js';
import {basename,join,isAbsolute} from 'node:path';
import {DesktopMicrophone} from './desktop-microphone.js';
import {setMicrophonePermission} from './window-policy.js';
import {readDesktopMedia,saveDesktopMedia} from './desktop-media-output.js';
import type {DesktopPublicSettings} from './public-settings.js';
import {validateHumanBrowserCommand,validateBrowserWorkspaceAction,validateHumanBrowserInput} from '@estacoda/control-protocol';
import type {DesktopBrowserControls} from './browser-controls.js';
import type {DesktopTerminalControls} from './terminal-controls.js';
import type {DesktopTargetControls} from './target-controls.js';
import {DesktopConnectionControls} from './connection-controls.js';
import type {DesktopTelegramSetup} from './telegram-setup.js';
import {WorkAttachmentError} from './work-attachments.js';
import type {DesktopWorkControls} from './work-controls.js';
import type {WorkPins} from './work-pins.js';
import type{DesktopModelSetup}from'./model-setup.js';
import{validAppearance}from'../shared/appearance.js';
import type{AppearanceSettings}from'./appearance-store.js';
import { clipboard,app,shell,systemPreferences,dialog,ipcMain, type BrowserWindow } from 'electron';
import { CONTROL_METHODS,CONTROL_EVENTS,validateControlRequest,exactKeys, isControlId, isRecord } from '@estacoda/control-protocol';
import type { DesktopSnapshot } from '../shared/desktop-api.js';
import type { DesktopConnection, ConnectionState } from './connection.js';
import { WindowAuthority } from './window-policy.js';
import type { Profiles } from './profiles.js';
export function rendererSnapshot(state:ConnectionState):DesktopSnapshot {
  return {...(state.databaseIssue?{databaseIssue:state.databaseIssue}:{}),counts:state.status==='ready'?state.counts??null:null,status:state.status,profile:state.bootstrap?.profile??{id:state.profileId,label:state.profileId,configuration:'unconfigured'},runtime:state.bootstrap?.runtime.state??'disconnected',work:state.work,inbox:state.inbox};
}
const libraryReads={schedulesDraft:'schedules.draft',schedulesList:'schedules.list',schedulesGet:'schedules.get',schedulesHistory:'schedules.history',librarySkills:'library.skills',librarySkill:'library.skill',libraryMemory:'library.memory',libraryProposals:'library.proposals',libraryProposal:'library.proposal'} as const;
export function validateSemanticPayload(method:string,payload:unknown):void {
 if(method==='updatesPreferences'){if(!isRecord(payload)||!exactKeys(payload,['automaticChecks'])||typeof payload.automaticChecks!=='boolean')throw Error('Invalid update preferences');return;}
 if(['updatesDownload','updatesCancel','updatesStatus','updatesCheck','installationRead','installationAcknowledge','installationInspect'].includes(method)){if(!isRecord(payload)||!exactKeys(payload,[]))throw new Error('Invalid installation request');return;}
 if(method==='clipboardWrite'){if(!isRecord(payload)||!exactKeys(payload,['text'])||typeof payload.text!=='string'||payload.text.length>1_000_000)throw new Error('Invalid clipboard text');return;}
 if(method==='chatRead'||method==='chatWrite'){if(!isRecord(payload)||!exactKeys(payload,method==='chatRead'?['profile']:['profile','value'])||!isControlId(payload.profile)||method==='chatWrite'&&!validChatPresentation(payload.value))throw new Error('Invalid chat presentation');return;}
 if(method==='chatOpenFolder'){if(!isRecord(payload)||!exactKeys(payload,['workId'])||!isControlId(payload.workId))throw new Error('Invalid chat reference');return;}
 if(['scheduleReview','scheduleCancel','scheduleExecute','scheduleInspect'].includes(method)){
  if(!isRecord(payload))throw new Error('Invalid schedule request');if(method==='scheduleInspect'){if(!exactKeys(payload,[]))throw new Error('Invalid inspection');return;}
  if(method==='scheduleExecute'&&!exactKeys(payload,['reviewId','confirmed']))throw new Error('Invalid schedule confirmation');
  validateControlRequest({jsonrpc:'2.0',id:'v',method:method==='scheduleReview'?'schedules.review':method==='scheduleCancel'?'schedules.cancel':'schedules.execute',params:method==='scheduleExecute'?{...payload,operationId:'main'}:payload},{profileId:'v',instanceId:'v',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;
 }
 if(method.startsWith('evolution')){if(!isRecord(payload))throw new Error('Invalid Evolution request');
  if(method==='evolutionInspect'){if(!exactKeys(payload,[]))throw new Error('Invalid inspection');return;}
  const rpc=method==='evolutionReview'?'evolution.review':method==='evolutionCancel'?'evolution.cancel':method==='evolutionExecute'?'evolution.execute':null;
  if(!rpc||method==='evolutionExecute'&&!exactKeys(payload,['reviewId','confirmed']))throw new Error('Invalid Evolution request');
  validateControlRequest({jsonrpc:'2.0',id:'v',method:rpc,params:method==='evolutionExecute'?{...payload,operationId:'main'}:payload},{profileId:'v',instanceId:'v',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;
 }
 if(Object.hasOwn(libraryReads,method)){validateControlRequest({jsonrpc:'2.0',id:'validation',method:libraryReads[method as keyof typeof libraryReads],params:payload},{profileId:'v',instanceId:'v',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
 if(method==='onboardingVerify'){if(!isRecord(payload)||!exactKeys(payload,[],['alias'])||payload.alias!==undefined&&(typeof payload.alias!=='string'||payload.alias.length>64||!payload.alias.length))throw new Error('Invalid setup verification.');return;}
 if(method==='onboardingReview'){
  if(!isRecord(payload)||!exactKeys(payload,['modelSetupId','preferences','workspaceReviewId'],['optionalSetupId'])||!isControlId(payload.modelSetupId)||payload.optionalSetupId!==undefined&&!isControlId(payload.optionalSetupId))throw new Error('Invalid setup review.');
  validateControlRequest({jsonrpc:'2.0',id:'v',method:'setup.review',params:{model:{draftId:'main',windowId:'main',generation:1},preferences:payload.preferences,workspaceReviewId:payload.workspaceReviewId}},{profileId:'v',instanceId:'v',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;
 }
 if(['onboardingApply','onboardingApplyWorkspace'].includes(method)){if(!isRecord(payload)||!exactKeys(payload,['reviewId','confirmed'])||!isControlId(payload.reviewId)||payload.confirmed!==true)throw new Error('Setup confirmation required.');return;}
 if(method==='onboardingReviewWorkspace'){if(!isRecord(payload))throw new Error('Invalid workspace review.');validateControlRequest({jsonrpc:'2.0',id:'validation',method:'setup.reviewWorkspace',params:{...payload,path:'/main-selected'}},{profileId:'v',instanceId:'v',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});if(!exactKeys(payload,['alias','trust']))throw new Error('Invalid workspace review.');return;}
 if(method==='onboardingCancelWorkspace'){if(!isRecord(payload)||!exactKeys(payload,['reviewId'])||!isControlId(payload.reviewId))throw new Error('Invalid workspace cancellation.');return;}
 if(['onboardingInspect','onboardingRecover','onboardingChooseWorkspace','onboardingDetect','onboardingBootstrap'].includes(method)){if(!isRecord(payload)||!exactKeys(payload,[]))throw new Error('Invalid onboarding request.');return;}
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

  if(method==='workInputPending'){validateSemanticPayload('browserList',payload);return;}
  if(method==='workInputOpen'){if(!isRecord(payload)||!exactKeys(payload,['workId','requestId'])||!isControlId(payload.requestId))throw new Error('Invalid protected input.');validateSemanticPayload('browserList',{workId:payload.workId});return;}
  if(method==='connectorsControl'){validateControlRequest({jsonrpc:'2.0',id:'v',method:'connections.connectors',params:payload},{profileId:'v',instanceId:'v',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
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
  if(method==='workAttach'||method==='workAttachFiles'||method==='workSubmit'){
    if(!exactKeys(payload,method==='workSubmit'?['draftId','target','text','attachmentIds']:method==='workAttachFiles'?['draftId','target','paths']:['draftId','target'],method==='workSubmit'?['workId','selection','kind','limits','securityMode','interrupt','inspectOnly']:method==='workAttach'?['workspace']:[])||!isControlId(payload.draftId)||!isRecord(payload.target)||!exactKeys(payload.target,['targetId','targetGeneration'])||!isControlId(payload.target.targetId)||!Number.isSafeInteger(payload.target.targetGeneration)||Number(payload.target.targetGeneration)<1)throw new Error('Invalid Work input');
    if(method==='workAttach'&&payload.workspace!==undefined&&typeof payload.workspace!=='boolean')throw new Error('Invalid attachment source');
    if(method==='workAttachFiles'&&(!Array.isArray(payload.paths)||payload.paths.length<1||payload.paths.length>4||!payload.paths.every(path=>typeof path==='string'&&path.length>0&&path.length<=4096&&isAbsolute(path)&&!path.includes('\0'))))throw new Error('Invalid attachments');
    if(method==='workSubmit'){
      if(typeof payload.text!=='string'||payload.text.length>32768||!Array.isArray(payload.attachmentIds)||payload.attachmentIds.length>4||!payload.attachmentIds.every(isControlId)||payload.workId!==undefined&&!isControlId(payload.workId))throw new Error('Invalid prompt');
      if(payload.inspectOnly!==undefined&&typeof payload.inspectOnly!=='boolean')throw new Error('Invalid inspection');
      if((payload.securityMode!==undefined&&!['strict','adaptive','open'].includes(String(payload.securityMode)))||(payload.interrupt!==undefined&&typeof payload.interrupt!=='boolean')||(payload.kind==='task'&&(payload.securityMode!==undefined||payload.interrupt!==undefined)))throw new Error('Invalid conversation controls');
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
  if(method==='setupReview'){if(!exactKeys(payload,['setupId'],['role'])||!isControlId(payload.setupId))throw new Error('Invalid review');if(payload.role!==undefined){const role=payload.role;if(!isRecord(role)||!exactKeys(role,['role'],['slot','fallbackToMain'])||!['provider','primary','fallback','auxiliary'].includes(String(role.role))||role.role==='auxiliary'&&(!['assessor','compression','session_search','memory_compaction','profile_context'].includes(String(role.slot))||typeof role.fallbackToMain!=='boolean')||role.role!=='auxiliary'&&('slot' in role||'fallbackToMain' in role))throw new Error('Invalid route role');}return;}
  if(method==='telegramExecute'){if(!exactKeys(payload,['action','confirmed'],['destination'])||!['pairingCreate','pairingCancel','sync','test'].includes(String(payload.action))||payload.confirmed!==true||payload.destination!==undefined&&(typeof payload.destination!=='string'||!/^\-?\d{1,20}$/.test(payload.destination)))throw new Error('Invalid Telegram action');return;}
  if(method==='telegramDetails'||method==='telegramHandoff'){if(!exactKeys(payload,method==='telegramDetails'?['workId']:['workId','action','confirmed'],method==='telegramDetails'?[]:['attachmentId'])||!isControlId(payload.workId)||method==='telegramHandoff'&&(!['create','revoke','detach'].includes(String(payload.action))||payload.confirmed!==true||payload.attachmentId!==undefined&&(typeof payload.attachmentId!=='string'||payload.attachmentId.length>512)))throw new Error('Invalid handoff');return;}
  if(method==='gatewayExecute'){if(!exactKeys(payload,['action','acknowledgeSharedWork'])||!['install','start','stop','restart'].includes(String(payload.action))||payload.acknowledgeSharedWork!==true)throw new Error('Invalid gateway action');return;}
  if(method==='telegramReview'){if(!exactKeys(payload,['setupId','settings'])||!isControlId(payload.setupId))throw new Error('Invalid Telegram review.');validateControlRequest({jsonrpc:'2.0',id:'validation',method:'telegram.review',params:{windowId:'validation',generation:1,settings:payload.settings}},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  if(method==='setupBegin'){validateControlRequest({jsonrpc:'2.0',id:'validation',method:'models.validateRoute',params:payload},{profileId:'validation',instanceId:'validation',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return;}
  const valid=['telegramApply','telegramStage','telegramVerify','telegramCancel','setupOAuthStart','setupOAuthStatus','setupOAuthOpen','setupStage','setupVerify','setupReview','setupApply','setupCancel'].includes(method)?exactKeys(payload,['setupId'])&&isControlId(payload.setupId):['modelPage','providerPage'].includes(method)?exactKeys(payload,[],['cursor'])&&(payload.cursor===undefined||typeof payload.cursor==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(payload.cursor)):method==='setAppearance'?validAppearance(payload):method==='getWork'?exactKeys(payload,['workId'])&&isControlId(payload.workId):(method==='activity'||method==='workChildren')?exactKeys(payload,['workId'],['cursor'])&&isControlId(payload.workId)&&(payload.cursor===undefined||typeof payload.cursor==='string'&&payload.cursor.length<=2048)
    :method==='switchProfile'?exactKeys(payload,['id'])&&isControlId(payload.id):exactKeys(payload,[]);
  if(!valid)throw new Error('Desktop request rejected.');
}
export function installSemanticIpc(window:BrowserWindow,documentUrl:string,connection:DesktopConnection,profiles:Profiles,appearance:AppearanceSettings,models?:DesktopModelSetup,pins?:WorkPins,workControls?:DesktopWorkControls,telegram?:DesktopTelegramSetup,connectionControls?:DesktopConnectionControls,targets?:DesktopTargetControls,terminals?:DesktopTerminalControls,browsers?:DesktopBrowserControls,settings?:DesktopPublicSettings,workInput?:DesktopWorkInput):()=>void {
  const chats=new ChatPresentationStore(app.getPath('userData'),()=>connection.state.profileId);
  const authority=new WindowAuthority(window,documentUrl);
  const contents=window.webContents;
  const microphone=workControls?new DesktopMicrophone(connection,app.getPath('temp'),()=>process.platform==='darwin'?systemPreferences.askForMediaAccess('microphone'):Promise.resolve(true),enabled=>setMicrophonePermission(window,documentUrl,enabled),(scope,path)=>workControls.stageRecording(scope,path)):undefined;
  let onboardingReview:{id:string;modelId:string;optionalId?:string}|undefined;
  let onboardingFolder:{path:string;profileId:string;generation:number}|undefined;
  const scheduleControls=new DesktopConnectionControls(connection,join(app.getPath('userData'),'schedules')),scheduleReviews=new Map<string,number>();
  const evolutionControls=new DesktopConnectionControls(connection,join(app.getPath('userData'),'evolution'));
  const evolutionReviews=new Map<string,number>();
  const installWelcome=new InstallWelcome(app.getPath('userData'));
  const methods=['updatesDownload','updatesCancel','updatesPreferences','updatesStatus','updatesCheck','installationRead','installationAcknowledge','installationInspect','connectorsControl','clipboardWrite','chatRead','chatWrite','chatOpenFolder','workInputPending','workInputOpen','scheduleReview','scheduleCancel','scheduleExecute','scheduleInspect','evolutionReview','evolutionCancel','evolutionExecute','evolutionInspect',...Object.keys(libraryReads),'onboardingVerify','onboardingReview','onboardingApply','onboardingApplyWorkspace','onboardingInspect','onboardingRecover','onboardingChooseWorkspace','onboardingReviewWorkspace','onboardingCancelWorkspace','onboardingDetect','onboardingBootstrap','recordBegin','recordAppend','recordFinish','recordCancel','artifactsMedia','artifactsSave','settingsLifecycle','settingsWorkspaces','settingsReviewAction','settingsExecuteAction','settingsCancelAction','settingsDependencies','settingsInstall','settingsInspectDependency','settingsValue','settingsRead','settingsBegin','settingsStage','settingsReview','settingsApply','settingsCancel','settingsInspect','settingsVerify','browserControlWatch','browserControlSignIn','browserControlInventory','browserControlWorkspaceOpen','browserControlWorkspace','browserControlOpen','browserControlFrame','browserControlRelease','browserControlAbandon','browserList','browserSnapshot','artifactsList','artifactsGet','artifactsOpen','evidenceGet','terminalOpen','terminalRead','terminalWrite','terminalResize','terminalClose','diffList','diffPatch','filesList','filesPreview','targetList','targetInspect','targetReview','targetCreate','targetCancel','targetExecute','targetOperation','telegramExecute','telegramPairing','telegramSessions','telegramDetails','telegramHandoff','gatewayDiagnostics','gatewayExecute','connectionInspect','telegramReview','telegramApply','telegramInspectApply','telegramBegin','telegramStage','telegramVerify','telegramCancel','connectionsList','workUsage','workDecide','workInspectDecision','workAct','workChildren','workLive','workTargets','workAttach','workAttachFiles','workSubmit','workInspect','workSearch','workPins','workPin','workOverride','setOverride','inspectOverride','setupVerifyReviewed','modelRoutes','setupConfigured','setupOrder','setupMode','setupOAuthStart','setupOAuthStatus','setupOAuthOpen','setupBegin','setupStage','setupVerify','setupReview','setupApply','setupCancel','setupInspect','modelPage','providerPage','refreshCatalog','reconnect','moreWork','moreInbox','appearance','setAppearance','snapshot','getWork','activity','profiles','switchProfile','minimize','toggleMaximize','close'];
  const handlers:string[]=[];
  let connectionGeneration=connection.state.generation;
  const state=(value:ConnectionState)=>{if(value.generation!==connectionGeneration){authority.invalidate();evolutionReviews.clear();scheduleReviews.clear();connectionGeneration=value.generation;}if(!window.isDestroyed())contents.send('desktop:state',{generation:authority.generation,snapshot:rendererSnapshot(value)});};
  connection.on('state',state);
  for(const method of methods){
    const channel='desktop:'+method;handlers.push(channel);
    ipcMain.handle(channel,async(event,envelope:unknown)=>{
      if(!isRecord(envelope)||!exactKeys(envelope,['generation','payload'])||!Number.isSafeInteger(envelope.generation))throw new Error('Desktop request rejected.');
      authority.assertSender(event,Number(envelope.generation));validateSemanticPayload(method,envelope.payload);
      const payload=envelope.payload as Record<string,unknown>;
      const generation=authority.generation;
      try {
        if(method==='updatesPreferences')return desktopUpdates().preferences(payload.automaticChecks as boolean);
        if(method==='updatesDownload'||method==='updatesCancel'){const result=await (method==='updatesDownload'?desktopUpdates().download():desktopUpdates().cancel());authority.assertSender(event,generation);return result;}
        if(method==='updatesCheck'){const result=await desktopUpdates().check();authority.assertSender(event,generation);return result;}
        if(method==='updatesStatus')return desktopUpdates().status();
        if(method==='installationRead')return installWelcome.read();
        if(method==='installationAcknowledge'){installWelcome.acknowledge();return;}
        if(method==='installationInspect'){const result=await connection.settingsRequest('setup.local',{});authority.assertSender(event,generation);return result;}
        if(['scheduleReview','scheduleCancel','scheduleExecute','scheduleInspect'].includes(method)){
          if(method==='scheduleReview'){const result=await connection.settingsRequest('schedules.review',payload as import('@estacoda/control-protocol').ScheduleAction);authority.assertSender(event,generation);scheduleReviews.set(result.reviewId,generation);return result;}
          if(method==='scheduleInspect'){const result=await scheduleControls.inspect();authority.assertSender(event,generation);return result;}
          const id=payload.reviewId as string;if(scheduleReviews.get(id)!==generation)throw new Error('Review again in this window.');scheduleReviews.delete(id);
          const result=method==='scheduleCancel'?await connection.settingsRequest('schedules.cancel',{reviewId:id}):await scheduleControls.perform('schedule',operationId=>connection.settingsRequest('schedules.execute',{reviewId:id,operationId,confirmed:true}));authority.assertSender(event,generation);return result;
        }
        if(method.startsWith('evolution')){
          if(method==='evolutionReview'){const result=await connection.settingsRequest('evolution.review',payload as import('@estacoda/control-protocol').MethodContracts['evolution.review']['params']);authority.assertSender(event,generation);evolutionReviews.set(result.reviewId,generation);return result;}
          if(method==='evolutionInspect'){const result=await evolutionControls.inspect();authority.assertSender(event,generation);return result;}
          const id=payload.reviewId as string;if(evolutionReviews.get(id)!==generation)throw new Error('Review again in this window.');evolutionReviews.delete(id);
          const result=method==='evolutionCancel'?await connection.settingsRequest('evolution.cancel',{reviewId:id}):await evolutionControls.perform('evolution',operationId=>connection.settingsRequest('evolution.execute',{reviewId:id,operationId,confirmed:true}));authority.assertSender(event,generation);return result;
        }
        if(Object.hasOwn(libraryReads,method)){const result=await connection.settingsRequest(libraryReads[method as keyof typeof libraryReads],payload as never);authority.assertSender(event,generation);return result;}
        if(method==='onboardingVerify'){const result=await connection.settingsRequest('setup.verify',payload.alias?{alias:payload.alias as string}:{});authority.assertSender(event,generation);return result;}
        if(method==='onboardingReview'){
          if(!models)throw new Error('Setup unavailable.');
          const optional=payload.optionalSetupId?settings?.onboardingBinding(payload.optionalSetupId as string):undefined;if(payload.optionalSetupId&&!optional)throw new Error('Optional draft unavailable.');
          const result=await connection.settingsRequest('setup.review',{model:models.onboardingBinding(payload.modelSetupId as string),...(optional?{optional}:{}),preferences:payload.preferences as import('@estacoda/control-protocol').SettingChange[],workspaceReviewId:payload.workspaceReviewId as string});authority.assertSender(event,generation);onboardingReview={id:result.reviewId,modelId:payload.modelSetupId as string,optionalId:payload.optionalSetupId as string|undefined};return result;
        }
        if(method==='onboardingApply'){const review=onboardingReview;if(!review||review.id!==payload.reviewId)throw new Error('Review setup first.');const result=await connection.settingsRequest('setup.apply',{reviewId:review.id,confirmed:true});authority.assertSender(event,generation);if(result.state==='applied'||result.state==='uncertain'){await models!.finishOnboarding(review.modelId);if(review.optionalId)await settings!.finishOnboarding(review.optionalId);onboardingReview=undefined;}return result;}
        if(method==='onboardingApplyWorkspace'){if(!connectionControls)throw new Error('Workspace operations unavailable.');const result=await connectionControls.perform('onboarding.workspace',operationId=>connection.settingsRequest('setup.applyWorkspace',{reviewId:payload.reviewId as string,operationId,confirmed:true}));authority.assertSender(event,generation);return result;}
        if(method==='onboardingInspect'||method==='onboardingRecover'){const result=await connection.settingsRequest(method==='onboardingInspect'?'settings.inspect':'setup.recover',{});authority.assertSender(event,generation);return result;}
        if(method==='onboardingChooseWorkspace'){
          const profileId=connection.state.profileId,connectionGeneration=connection.state.generation;
          const picked=await dialog.showOpenDialog(window,{properties:['openDirectory']});authority.assertSender(event,generation);
          if(profileId!==connection.state.profileId||connectionGeneration!==connection.state.generation)throw new Error('Setup context changed.');
          if(picked.canceled||picked.filePaths.length!==1)return null;
          onboardingFolder={path:picked.filePaths[0]!,profileId,generation:connectionGeneration};
          const slug=basename(onboardingFolder.path).toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/^-+|-+$/g,'').slice(0,55);
          return {path:onboardingFolder.path,alias:/^[a-z]/.test(slug)?slug:'workspace'+(slug?'-'+slug:'')};
        }
        if(method==='onboardingReviewWorkspace'){
          if(!onboardingFolder||onboardingFolder.profileId!==connection.state.profileId||onboardingFolder.generation!==connection.state.generation)throw new Error('Choose a workspace again.');
          const result=await connection.settingsRequest('setup.reviewWorkspace',{path:onboardingFolder.path,alias:payload.alias as string,trust:payload.trust as boolean});authority.assertSender(event,generation);return result;
        }
        if(method==='onboardingCancelWorkspace'){const result=await connection.settingsRequest('setup.cancelWorkspace',{reviewId:payload.reviewId as string});authority.assertSender(event,generation);return result;}
        if(method==='onboardingDetect'||method==='onboardingBootstrap'){const result=await connection.settingsRequest(method==='onboardingDetect'?'setup.detect':'setup.bootstrap',{});authority.assertSender(event,generation);return result;}
        if(method.startsWith('record')){if(!microphone)throw new Error('Recording unavailable');const result=method==='recordBegin'?await microphone.begin(payload as import('./desktop-microphone.js').CaptureScope):method==='recordAppend'?microphone.append(payload.id as string,payload.data as string):method==='recordFinish'?await microphone.finish(payload.id as string):microphone.cancel(payload.id as string);authority.assertSender(event,generation);return result;}
        if(method.startsWith('settings')){
         if(!settings)throw new Error('Settings unavailable.');
         const result=method==='settingsLifecycle'?await settings.lifecycle():method==='settingsWorkspaces'?await settings.workspaces():method==='settingsReviewAction'?await settings.reviewAction(payload as import('@estacoda/control-protocol').SettingsAction):method==='settingsExecuteAction'?await settings.executeAction(payload.reviewId as string):method==='settingsCancelAction'?await settings.cancelAction(payload.reviewId as string):method==='settingsDependencies'?await settings.dependencies():method==='settingsInstall'?await settings.install(payload.capabilityId as string,payload.groups as string[]):method==='settingsInspectDependency'?await settings.inspectDependency():method==='settingsValue'?await settings.value(payload.fieldId as string,payload.selectors as string[]):method==='settingsRead'?await settings.read(payload.section as import('@estacoda/control-protocol').SettingsSection,payload.offset as number|undefined):method==='settingsBegin'?settings.begin():method==='settingsStage'?await settings.stage(payload.setupId as string,payload.fieldId as string,payload.selectors as string[]):method==='settingsReview'?await settings.review(payload.setupId as string,payload.changes as import('@estacoda/control-protocol').SettingChange[]):method==='settingsApply'?await settings.apply(payload.setupId as string):method==='settingsCancel'?await settings.cancel(payload.setupId as string):method==='settingsInspect'?await settings.inspect():await settings.verify();
         authority.assertSender(event,generation);return result;
        }
        if(method==='workInputPending'||method==='workInputOpen'){if(!workInput)throw new Error('Secure input unavailable.');const result=method==='workInputPending'?await workInput.pending(payload.workId as string):await workInput.open(payload.workId as string,payload.requestId as string);authority.assertSender(event,Number(envelope.generation));return result??null;}
        if(method.startsWith('browserControl')){
          if(!browsers)throw new Error('Browser controls unavailable.');
          const result=method==='browserControlWatch'?await browsers.watch(payload.workId as string,payload.browserId as string):method==='browserControlSignIn'?await browsers.signIn(payload.id as string,payload.frameId as string,payload.submitRef as string,payload.kind as 'password'|'one-time-code'):method==='browserControlInventory'?await browsers.inventory(payload.workId as string):method==='browserControlWorkspaceOpen'?await browsers.open(payload.workId as string):method==='browserControlWorkspace'?await browsers.workspace(payload.id as string,payload.operation as import('@estacoda/control-protocol').BrowserWorkspaceAction):method==='browserControlOpen'?await browsers.open(payload.workId as string,payload.reference as import('@estacoda/control-protocol').BrowserViewReference):method==='browserControlFrame'?await browsers.frame(payload.id as string,payload.input as import('@estacoda/control-protocol').HumanBrowserInput|undefined):method==='browserControlRelease'?await browsers.release(payload.id as string):browsers.abandon(payload.id as string);
          authority.assertSender(event,generation);return result;
        }
        if(method==='connectorsControl'){const result=await connection.connectionRequest('connections.connectors',payload as import('@estacoda/control-protocol').MethodContracts['connections.connectors']['params']);authority.assertSender(event,generation);return result;}
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
        if(['workTargets','workAttach','workAttachFiles','workSubmit','workInspect'].includes(method)){
          if(!workControls)throw new Error('Work unavailable');
          const result=method==='workTargets'?await connection.workRequest('work.targets',payload):method==='workAttach'?await workControls.attach(payload as Parameters<DesktopWorkControls['attach']>[0]):method==='workAttachFiles'?await workControls.attachFiles(payload as Parameters<DesktopWorkControls['attachFiles']>[0],payload.paths as string[]):method==='workSubmit'?await workControls.submit(payload as Parameters<DesktopWorkControls['submit']>[0]):await workControls.inspect(payload.workId as string);
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
        if(method==='clipboardWrite'){clipboard.writeText(payload.text as string);return;}
        if(method==='chatRead')return chats.read(payload.profile as string);
        if(method==='chatWrite'){chats.write(payload.profile as string,payload.value);return;}
        if(method==='chatOpenFolder'){
          const context=connection.state;const work=await connection.getWork(payload.workId as string);
          if(!work.target||work.profileId!==context.profileId)throw new Error('Workspace unavailable');
          const target=await connection.targetRequest('targets.inspect',{target:{targetId:work.target.targetId,targetGeneration:work.target.targetGeneration}});
          authority.assertSender(event,generation);
          if(connection.state.generation!==context.generation||connection.state.profileId!==context.profileId||target.readiness!=='ready')throw new Error('Workspace changed');
          const error=await shell.openPath(target.workingRoot);if(error)throw new Error('Workspace could not be opened');return;
        }
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
