import {detectOnboarding,bootstrapOnboarding} from './onboarding-detection.js';
import {settingsLifecycle} from './settings-lifecycle.js';
import {DesktopMediaOutput} from './desktop-media-output.js';
import {DesktopMediaInput} from '../artifacts/desktop-media-input.js';
import {SettingsActions} from './settings-actions.js';
import {SettingsDependencies} from './settings-dependencies.js';
import {PublicSettings} from './public-settings.js';
import {validateHumanBrowserCommand,exactKeys,isRecord,isControlId} from '../contracts/desktop-control/index.js';
import {browserControl} from './browser-control.js';
import {browserViewSnapshot} from './browser-snapshot.js';
import {listBrowserViews} from './browser-view.js';
import {listArtifacts,inspectArtifact} from './artifacts.js';
import {workEvidence} from './evidence.js';
import {TerminalCapabilities} from './terminal-capabilities.js';
import {inspectDiff} from './workspace-diff.js';
import {inspectFiles} from './workspace-files.js';
import {TargetControls} from './target-controls.js';
import {ChannelSessions} from './channel-sessions.js';
import {TelegramOperations} from './telegram-operations.js';
import {GatewayControls} from './gateway-controls.js';
import {TelegramVerifier} from './telegram-verification.js';
import {TelegramSetup} from './telegram-setup.js';
import {telegramConnection} from './connections.js';
import {workUsage} from './work-usage.js';
import {workCounts} from './work-counts.js';
import {liveWork} from './work-live.js';
import {availableWorkTargets} from './work-targets.js';
import {refreshDesktopCatalog} from './catalog-refresh.js';
import {CodexAuthorization} from './codex-authorization.js';
import {workModel} from './work-model.js';
import {notifyPrivateConfigurationChanged} from '../gateway/private-control.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {ModelSetup} from './model-setup.js';
import {recoverProfileApply} from '../setup/review/profile-apply.js';
import {validateCandidateRequest,CandidateVerifier} from './candidate-verification.js';
import {CredentialCandidates} from './credential-candidates.js';
import {captureModelCatalog} from './model-catalog.js';
import { WorkMonitor } from './work-monitor.js';
import { sessionControl, type SessionMutationRequest } from './session-controls.js';
import { captureWork, WorkSnapshot, type WorkState } from './work-snapshot.js';
import { ControlSubscriptions } from './subscriptions.js';
import { RuntimeStateMonitor } from './runtime-notifications.js';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { ControlProtocolError, type BootstrapResult, type ControlCursor } from '../contracts/desktop-control/index.js';
import { profileConfiguration } from './bootstrap.js';
import { supervisorReadiness } from './supervisor-client.js';
import { StdioControlServer } from './stdio-server.js';
export type BootstrapState = Pick<BootstrapResult, 'profile' | 'runtime'>;
/** One bridge per trusted Main client context; Work and execution remain core-owned. */
export class DesktopBridge {
  readonly terminals:TerminalCapabilities;
  readonly targets:TargetControls;
  readonly server: StdioControlServer;
  readonly candidates: CredentialCandidates;
  readonly modelSetup: ModelSetup;
  readonly publicSettings:PublicSettings;
  readonly mediaOutput:DesktopMediaOutput;
  readonly settingsActions:SettingsActions;
  readonly settingsDependencies:SettingsDependencies;
  readonly channelSessions:ChannelSessions;
  readonly telegramOperations:TelegramOperations;
  readonly gatewayControls:GatewayControls;
  readonly telegramVerifier:TelegramVerifier;
  readonly telegramSetup: TelegramSetup;
  readonly verifier: CandidateVerifier;
  readonly subscriptions: ControlSubscriptions;
  #catalog: ReturnType<typeof captureModelCatalog> | undefined;
  #generation = 0;
  #work: WorkSnapshot | undefined;
  #workMonitor: WorkMonitor | undefined;
  #monitor: RuntimeStateMonitor | undefined;
  #capture: AbortController | undefined;
  #snapshot: BootstrapResult | undefined;
  readonly oauth:CodexAuthorization;
  async deliverBrowserInput(params:unknown,signal:AbortSignal):Promise<void>{
    if(!isRecord(params)||!exactKeys(params,['workId','command'])||!isControlId(params.workId))throw new ControlProtocolError('-32602');
    validateHumanBrowserCommand(params.command);
    if(params.command.action!=='signin-deliver')throw new ControlProtocolError('-32602');
    try{await browserControl(this.options,this.workSnapshot().get(params.workId),params.command,signal);}
    finally{params.command.value='';}
  }
  constructor(readonly options: { input: Readable; output: Writable; homeDir: string; profileId: string; version: string;
    readWork?: (signal: AbortSignal) => Promise<WorkState>;
    readState?: (signal: AbortSignal) => Promise<BootstrapState> }) {
    this.server = new StdioControlServer({ ...options, events: ['work.changed', 'activity.appended', 'attention.changed', 'control.ready', 'service.warning', 'service.shutdown'], handlers: {
      ...Object.fromEntries(['tasks.create','sessions.setModel', 'tasks.setModel', 'approvals.resolve', 'tasks.pause', 'tasks.resume', 'tasks.cancel', 'tasks.retry', 'tasks.guide', 'sessions.start', 'sessions.resume', 'sessions.send', 'sessions.cancelTurn', 'operations.inspect'].map((method) =>
        [method, async (request: SessionMutationRequest, signal: AbortSignal) => ({ result: await sessionControl(this.options, request, signal) })])),
      'telegram.sessions':async()=>({result:await this.channelSessions.list()}),
      'telegram.sessionDetails':async request=>{if(request.method!=='telegram.sessionDetails')throw new ControlProtocolError('-32601');return{result:await this.channelSessions.details(request.params.sessionId)};},
      'telegram.handoff':async request=>{if(request.method!=='telegram.handoff')throw new ControlProtocolError('-32601');return{result:await this.channelSessions.execute(request.params)};},
      'telegram.execute':async(request,signal)=>{if(request.method!=='telegram.execute')throw new ControlProtocolError('-32601');return{result:await this.telegramOperations.execute(request.params,signal)};},
      'telegram.pairing':async()=>({result:await this.telegramOperations.pairing()}),
      'gateway.execute':async request=>{if(request.method!=='gateway.execute')throw new ControlProtocolError('-32601');return{result:await this.gatewayControls.execute(request.params.operationId,request.params.action)};},
      'gateway.diagnostics':async(_request,signal)=>({result:await this.gatewayControls.diagnostics(signal)}),
      'connections.inspectOperation':async request=>{if(request.method!=='connections.inspectOperation')throw new ControlProtocolError('-32601');return{result:await this.gatewayControls.operations.inspect(request.params.operationId)};},
      'telegram.verify':async(request,signal)=>{if(request.method!=='telegram.verify')throw new ControlProtocolError('-32601');return{result:await this.telegramVerifier.verify(request.params,signal)};},
      'telegram.settings':async()=>({result:await this.telegramSetup.settings()}),
      'telegram.review':async request=>{if(request.method!=='telegram.review')throw new ControlProtocolError('-32601');return{result:await this.telegramSetup.review(request.params)};},
      'telegram.apply':async(request,signal)=>{if(request.method!=='telegram.apply')throw new ControlProtocolError('-32601');return{result:await this.telegramSetup.apply(request.params,signal)};},
      'telegram.cancel':request=>{if(request.method!=='telegram.cancel')throw new ControlProtocolError('-32601');return{result:this.telegramSetup.cancel(request.params)};},
      'telegram.inspectApply':async request=>{if(request.method!=='telegram.inspectApply')throw new ControlProtocolError('-32601');return{result:await this.telegramSetup.inspect(request.params.operationId)};},
      'browser.snapshot':async(request,signal)=>{if(request.method!=='browser.snapshot')throw new ControlProtocolError('-32601');return{result:await browserViewSnapshot(this.options,this.workSnapshot().get(request.params.workId),request.params.reference,signal)};},
      'browser.control':async(request,signal)=>{if(request.method!=='browser.control')throw new ControlProtocolError('-32601');return{result:await browserControl(this.options,this.workSnapshot().get(request.params.workId),request.params.command,signal)};},
      'browser.list':async(request,signal)=>{if(request.method!=='browser.list')throw new ControlProtocolError('-32601');return{result:await listBrowserViews(this.options,this.workSnapshot().get(request.params.workId),signal)};},
      'connections.list':async(request,signal)=>{if(request.method!=='connections.list')throw new ControlProtocolError('-32601');if(request.params.cursor)throw new ControlProtocolError('-32007');return{result:{items:[await telegramConnection(this.options,signal)],nextCursor:null}};},
      'connections.get':async(request,signal)=>{if(request.method!=='connections.get'||request.params.connectionId!=='telegram')throw new ControlProtocolError('-32003');return{result:await telegramConnection(this.options,signal)};},
      'models.verifyDraft':async(request,signal)=>{if(request.method!=='models.verifyDraft')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.verifyDraft(request.params,signal,this.verifier)};},
      'models.reviewConfigured':async(request)=>{if(request.method!=='models.reviewConfigured')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.reviewConfigured(request.params)};},
      'models.validateRoute':request=>{if(request.method!=='models.validateRoute')throw new ControlProtocolError('-32601');validateCandidateRequest({windowId:'validation',generation:1,route:request.params.route,spendApproved:true,...(request.params.route.authMethod==='none'?{}:{candidateId:'validation'})});return {result:{valid:true}};},
      'models.refreshCatalog':async(_request,signal)=>{const result=await refreshDesktopCatalog(this.options.homeDir,signal);if(result.refreshed)this.#catalog=undefined;return {result};},
      'models.oauthStart': request=>{if(request.method!=='models.oauthStart')throw new ControlProtocolError('-32601');return {result:this.oauth.start(request.params)};},
      'models.oauthStatus': request=>{if(request.method!=='models.oauthStatus')throw new ControlProtocolError('-32601');return {result:this.oauth.status(request.params)};},
      'models.oauthCancel': request=>{if(request.method!=='models.oauthCancel')throw new ControlProtocolError('-32601');return {result:this.oauth.cancel(request.params)};},
      'models.workOverride': async(request)=>{if(request.method!=='models.workOverride')throw new ControlProtocolError('-32601');return {result:await workModel(this.options,request.params)};},
      'models.auxiliary': async()=>({result:await this.modelSetup.auxiliary()}),
      'models.reviewAuxiliary': async(request)=>{if(request.method!=='models.reviewAuxiliary')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.review(request.params,'auxiliary',{slot:request.params.slot,fallbackToMain:request.params.fallbackToMain})};},
      'models.reviewAuxiliaryMode': async(request)=>{if(request.method!=='models.reviewAuxiliaryMode')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.reviewAuxiliaryMode(request.params)};},
      'models.fallbacks': async()=>({result:await this.modelSetup.fallbacks()}),
      'models.reviewFallback': async(request)=>{if(request.method!=='models.reviewFallback')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.review(request.params,'fallback')};},
      'models.reviewFallbackOrder': async(request)=>{if(request.method!=='models.reviewFallbackOrder')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.reviewFallbackOrder(request.params)};},
      'models.reviewPrimary': async(request) => {if(request.method!=='models.reviewPrimary')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.review(request.params)};},
      'settings.workspaces':async()=>({result:await this.settingsActions.workspaces()}),
      'settings.reviewAction':async request=>{if(request.method!=='settings.reviewAction')throw new ControlProtocolError('-32601');return {result:await this.settingsActions.review(request.params)};},
      'settings.executeAction':async request=>{if(request.method!=='settings.executeAction')throw new ControlProtocolError('-32601');return {result:await this.settingsActions.execute(request.params)};},
      'settings.cancelAction':request=>{if(request.method!=='settings.cancelAction')throw new ControlProtocolError('-32601');return {result:this.settingsActions.cancel(request.params.reviewId)};},
      'media.stage':async(request,signal)=>{if(request.method!=='media.stage')throw new ControlProtocolError('-32601');const page=await availableWorkTargets(this.options,signal,{target:request.params.target});if(!page.items.length)throw new ControlProtocolError('-32003');return {result:await new DesktopMediaInput(this.options).stage(request.params.path,request.params.target)};},
      'artifacts.mediaBegin':async request=>{if(request.method!=='artifacts.mediaBegin')throw new ControlProtocolError('-32601');return {result:await this.mediaOutput.begin(request.params.reference)};},
      'artifacts.mediaChunk':request=>{if(request.method!=='artifacts.mediaChunk')throw new ControlProtocolError('-32601');return {result:this.mediaOutput.chunk(request.params.transferId,request.params.offset)};},
      'artifacts.mediaClose':request=>{if(request.method!=='artifacts.mediaClose')throw new ControlProtocolError('-32601');return {result:this.mediaOutput.close(request.params.transferId)};},
      'settings.apply':async(request,signal)=>{if(request.method!=='settings.apply')throw new ControlProtocolError('-32601');return {result:await this.publicSettings.apply(request.params,signal)};},
      'settings.inspect':async request=>{if(request.method!=='settings.inspect')throw new ControlProtocolError('-32601');return {result:await this.publicSettings.inspect(request.params.operationId)};},
      'settings.verify':async()=>({result:await this.publicSettings.verify()}),
      'settings.value':async request=>{if(request.method!=='settings.value')throw new ControlProtocolError('-32601');return {result:await this.publicSettings.value(request.params)};},
      'setup.detect':async()=>({result:await detectOnboarding(this.options)}),
      'setup.bootstrap':async()=>({result:await bootstrapOnboarding(this.options)}),
      'settings.lifecycle':async()=>({result:await settingsLifecycle(this.options.version)}),
      'settings.dependencies':async()=>({result:await this.settingsDependencies.list()}),
      'settings.installDependency':async request=>{if(request.method!=='settings.installDependency')throw new ControlProtocolError('-32601');return {result:await this.settingsDependencies.start(request.params)};},
      'settings.inspectDependency':async request=>{if(request.method!=='settings.inspectDependency')throw new ControlProtocolError('-32601');return {result:await this.settingsDependencies.inspect(request.params.operationId)};},
      'settings.read':async request=>{if(request.method!=='settings.read')throw new ControlProtocolError('-32601');return {result:await this.publicSettings.read(request.params.section,request.params.offset)};},
      'settings.review':async request=>{if(request.method!=='settings.review')throw new ControlProtocolError('-32601');return {result:await this.publicSettings.review(request.params)};},
      'settings.cancel':request=>{if(request.method!=='settings.cancel')throw new ControlProtocolError('-32601');return {result:this.publicSettings.cancel(request.params)};},
      'models.applyDraft': async(request,signal) => {if(request.method!=='models.applyDraft')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.apply(request.params,signal)};},
      'models.cancelDraft': request => {if(request.method!=='models.cancelDraft')throw new ControlProtocolError('-32601');return {result:this.modelSetup.cancel(request.params)};},
      'models.inspectApply': async(request) => {if(request.method!=='models.inspectApply')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.inspect(request.params.operationId)};},
      'models.verifyCandidate': async(request, signal) => {
        if(request.method!=='models.verifyCandidate')throw new ControlProtocolError('-32601');
        return {result:await this.verifier.verify(request.params,signal)};
      },
      'providers.list': async(request) => {
        if(request.method!=='providers.list')throw new ControlProtocolError('-32601');
        const catalog=await this.modelCatalog();return{result:catalog.pages.page('providers',catalog.providers,request.params)};
      },
      'models.list': async(request) => {
        if(request.method!=='models.list')throw new ControlProtocolError('-32601');
        const catalog=await this.modelCatalog();return{result:catalog.pages.page('models',catalog.models,request.params)};
      },
      'inbox.get':request=>{if(request.method!=='inbox.get')throw new ControlProtocolError('-32601');const item=this.workSnapshot().state.inbox?.find(item=>item.id===request.params.itemId);if(!item)throw new ControlProtocolError('-32003');return{result:structuredClone(item)};},
      'inbox.list': (request) => {
        if (request.method !== 'inbox.list') throw new ControlProtocolError('-32601');
        const snapshot = this.workSnapshot();
        return { result: snapshot.page('inbox', snapshot.state.inbox ?? [], request.params) };
      },
      'work.usage':async(request,signal)=>{if(request.method!=='work.usage')throw new ControlProtocolError('-32601');return{result:await workUsage(this.options,this.workSnapshot().get(request.params.workId),signal)};},
      'work.counts':()=>({result:workCounts(this.workSnapshot().state)}),
      'work.live':async(request,signal)=>{if(request.method!=='work.live')throw new ControlProtocolError('-32601');return{result:await liveWork(this.options,this.workSnapshot().get(request.params.workId),signal)};},
      'artifacts.list':async(request,signal)=>{if(request.method!=='artifacts.list')throw new ControlProtocolError('-32601');return{result:await listArtifacts(this.options,request.params,signal)};},
      'artifacts.get':async(request,signal)=>{if(request.method!=='artifacts.get')throw new ControlProtocolError('-32601');return{result:await inspectArtifact(this.options,request.params.reference,false,signal)};},
      'artifacts.open':async(request,signal)=>{if(request.method!=='artifacts.open')throw new ControlProtocolError('-32601');return{result:await inspectArtifact(this.options,request.params.reference,true,signal)};},
      'evidence.get':async(request,signal)=>{if(request.method!=='evidence.get')throw new ControlProtocolError('-32601');return{result:await workEvidence(this.options,this.workSnapshot().get(request.params.workId),signal)};},
      'terminal.acquire':async(request,signal)=>{if(request.method!=='terminal.acquire')throw new ControlProtocolError('-32601');return{result:await this.terminals.acquire(request.params.target,signal)};},
      'terminal.verify':async(request,signal)=>{if(request.method!=='terminal.verify')throw new ControlProtocolError('-32601');return{result:await this.terminals.verify(request.params.capabilityId,signal)};},
      'terminal.release':async(request)=>{if(request.method!=='terminal.release')throw new ControlProtocolError('-32601');return{result:await this.terminals.release(request.params.capabilityId)};},
      'diff.list':async(request,signal)=>{if(request.method!=='diff.list')throw new ControlProtocolError('-32601');return{result:await inspectDiff(this.options,request.method,request.params,signal)};},
      'diff.patch':async(request,signal)=>{if(request.method!=='diff.patch')throw new ControlProtocolError('-32601');return{result:await inspectDiff(this.options,request.method,request.params,signal)};},
      'files.list':async(request,signal)=>{if(request.method!=='files.list')throw new ControlProtocolError('-32601');return{result:await inspectFiles(this.options,request.method,request.params,signal)};},
      'files.preview':async(request,signal)=>{if(request.method!=='files.preview')throw new ControlProtocolError('-32601');return{result:await inspectFiles(this.options,request.method,request.params,signal)};},
      'targets.list':async(request,signal)=>{if(request.method!=='targets.list')throw new ControlProtocolError('-32601');return{result:await this.targets.list(signal,request.params.cursor)};},
      'targets.inspect':async(request,signal)=>{if(request.method!=='targets.inspect')throw new ControlProtocolError('-32601');return{result:await this.targets.inspect(request.params.target,signal)};},
      'targets.reviewCreate':async(request,signal)=>{if(request.method!=='targets.reviewCreate')throw new ControlProtocolError('-32601');return{result:await this.targets.review(request.params.source,signal)};},
      'targets.create':async(request,signal)=>{if(request.method!=='targets.create')throw new ControlProtocolError('-32601');return{result:await this.targets.create(request.params,signal)};},
      'targets.cancelReview':request=>{if(request.method!=='targets.cancelReview')throw new ControlProtocolError('-32601');return{result:this.targets.cancel(request.params.reviewId)};},
      'targets.execute':async(request,signal)=>{if(request.method!=='targets.execute')throw new ControlProtocolError('-32601');return{result:await this.targets.execute(request.params,signal)};},
      'targets.inspectOperation':async request=>{if(request.method!=='targets.inspectOperation')throw new ControlProtocolError('-32601');return{result:await this.targets.operation(request.params.operationId)};},
      'work.targets':async(request,signal)=>{if(request.method!=='work.targets')throw new ControlProtocolError('-32601');return{result:await availableWorkTargets(this.options,signal,request.params)};},
      'work.list': (request) => {
        if (request.method !== 'work.list') throw new ControlProtocolError('-32601');
        const snapshot = this.workSnapshot();
        return { result: snapshot.search(request.params) };
      },
      'work.get': (request) => {
        if (request.method !== 'work.get') throw new ControlProtocolError('-32601');
        return { result: this.workSnapshot().get(request.params.workId) };
      },
      'work.activity': async (request) => {
        if (request.method !== 'work.activity') throw new ControlProtocolError('-32601');
        const snapshot = this.workSnapshot(); snapshot.get(request.params.workId);
        return { result: await snapshot.activity(request.params.workId, request.params) };
      },
      'control.bootstrap': async (_request, signal) => ({ result: await this.bootstrap(signal) }),
      'control.subscribe': (request, signal) => {
        if (request.method !== 'control.subscribe') throw new ControlProtocolError('-32601');
        return this.subscriptions.subscribe(request.params, signal);
      },
      'control.unsubscribe': (request) => {
        if (request.method !== 'control.unsubscribe') throw new ControlProtocolError('-32601');
        return { result: { removed: this.subscriptions.unsubscribe(request.params.subscriptionId) } };
      },
    } });
    this.terminals=new TerminalCapabilities(options);
    this.targets=new TargetControls(options);
    this.candidates = new CredentialCandidates(this.server.profileId,this.server.instanceId);
    this.mediaOutput=new DesktopMediaOutput(options);
    this.settingsActions=new SettingsActions(options);
    this.settingsDependencies=new SettingsDependencies(this.options);
    this.publicSettings=new PublicSettings(this.options,this.candidates,async()=>{this.#catalog=undefined;this.subscriptions.publish({type:'service.warning',payload:{reason:'configuration_changed'}});try{await notifyPrivateConfigurationChanged({directory:resolveProfileStateHome(this.options).gatewayStatePath,profileId:this.options.profileId,version:this.options.version,signal:AbortSignal.timeout(2000)});}catch{}});
    this.server.onDispose(()=>this.publicSettings.dispose());
    this.modelSetup = new ModelSetup(this.options,this.candidates,async()=>{this.#catalog=undefined;this.subscriptions.publish({type:'service.warning',payload:{reason:'configuration_changed'}});
      try {await notifyPrivateConfigurationChanged({directory:resolveProfileStateHome(this.options).gatewayStatePath,profileId:this.options.profileId,version:this.options.version,signal:AbortSignal.timeout(2000)});}catch{/* An absent owner will load the committed configuration on its next startup. */}
    });
    this.channelSessions=new ChannelSessions(this.options);
    this.telegramOperations=new TelegramOperations(this.options);
    this.gatewayControls=new GatewayControls(this.options);
    this.telegramVerifier=new TelegramVerifier(this.options,this.candidates);
    this.server.onDispose(()=>this.telegramVerifier.dispose());
    this.telegramSetup=new TelegramSetup(this.options,this.candidates,async()=>{this.subscriptions.publish({type:'service.warning',payload:{reason:'configuration_changed'}});try{await notifyPrivateConfigurationChanged({directory:resolveProfileStateHome(this.options).gatewayStatePath,profileId:this.options.profileId,version:this.options.version,signal:AbortSignal.timeout(2000)});}catch{}},this.telegramVerifier);
    this.server.onDispose(()=>{this.telegramSetup.dispose();this.terminals.dispose();this.targets.dispose();});
    this.verifier = new CandidateVerifier(this.candidates);
    this.oauth=new CodexAuthorization(this.candidates);
    this.server.onDispose(() => {this.oauth.dispose();this.modelSetup.dispose();this.verifier.dispose();this.candidates.dispose();});
    this.subscriptions = new ControlSubscriptions(this.server);
    this.server.onDispose(() => { this.#capture?.abort(); this.#monitor?.dispose(); this.#workMonitor?.dispose(); this.#snapshot = undefined; this.#work = undefined; this.#catalog=undefined; });
  }
  private modelCatalog() {
    return this.#catalog ??= captureModelCatalog(this.options).catch(error=>{this.#catalog=undefined;throw error;});
  }
  get snapshot(): BootstrapResult | undefined { return this.#snapshot ? structuredClone(this.#snapshot) : undefined; }
  async bootstrap(signal: AbortSignal): Promise<BootstrapResult> {
    const generation = ++this.#generation;
    this.#monitor?.dispose(); this.#workMonitor?.dispose(); this.subscriptions.reset();
    this.#capture?.abort(); this.#capture = new AbortController(); this.#snapshot = undefined; this.#work = undefined;
    const combined = AbortSignal.any([signal, this.#capture.signal]);
    let state: BootstrapState;
    try { state = this.options.readState ? await this.options.readState(combined) : await this.readState(combined); }
    catch (error) { if (generation !== this.#generation) throw new ControlProtocolError('-32007'); throw error; }
    const work = await (this.options.readWork ? this.options.readWork(combined) : captureWork(this.options, combined));
    if (generation !== this.#generation || this.server.closed) throw new ControlProtocolError('-32007');
    combined.throwIfAborted();
    if (state.profile.id !== this.server.profileId) throw new ControlProtocolError('-32003');
    const context = this.server.context;
    if (!context) throw new ControlProtocolError('-32002');
    const cursor: ControlCursor = { instanceId: this.server.instanceId, streamId: randomUUID(), sequence: 0 };
    this.#work = new WorkSnapshot(work, this.options);
    this.#snapshot = structuredClone({ ...state, capabilities: context.capabilities, cursor });
    this.subscriptions.reset(cursor);
    this.subscriptions.publish({ type: 'control.ready', payload: { state: 'ready' } });
    this.#monitor = new RuntimeStateMonitor(state, (signal) => this.options.readState ? this.options.readState(signal) : this.readState(signal),
      (event) => { if (generation === this.#generation && !this.server.closed) { this.subscriptions.publish(event); } });
    this.#workMonitor = new WorkMonitor(work, (signal) => this.options.readWork ? this.options.readWork(signal) : captureWork(this.options, signal),
      (event) => { if (generation === this.#generation && !this.server.closed) this.subscriptions.publish(event); });
    return structuredClone(this.#snapshot);
  }
  private workSnapshot(): WorkSnapshot {
    if (!this.#work) throw new ControlProtocolError('-32007');
    return this.#work;
  }
  close(): void {
    this.mediaOutput.dispose();
    this.subscriptions.publish({ type: 'service.shutdown', payload: { reason: 'client_closed' } });
    this.server.close();
  }
  private async readState(signal: AbortSignal): Promise<BootstrapState> {
    if(await recoverProfileApply(this.options))await this.modelSetup.changed();
    signal.throwIfAborted();
    const [configuration, runtime] = await Promise.all([profileConfiguration(this.options), supervisorReadiness({ ...this.options, signal })]);
    return { profile: { id: this.server.profileId, label: this.server.profileId, configuration }, runtime };
  }
}
