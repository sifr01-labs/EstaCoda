import {notifyPrivateConfigurationChanged} from '../gateway/private-control.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {ModelSetup} from './model-setup.js';
import {recoverProfileApply} from '../setup/review/profile-apply.js';
import {CandidateVerifier} from './candidate-verification.js';
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
  readonly server: StdioControlServer;
  readonly candidates: CredentialCandidates;
  readonly modelSetup: ModelSetup;
  readonly verifier: CandidateVerifier;
  readonly subscriptions: ControlSubscriptions;
  #catalog: ReturnType<typeof captureModelCatalog> | undefined;
  #generation = 0;
  #work: WorkSnapshot | undefined;
  #workMonitor: WorkMonitor | undefined;
  #monitor: RuntimeStateMonitor | undefined;
  #capture: AbortController | undefined;
  #snapshot: BootstrapResult | undefined;
  constructor(readonly options: { input: Readable; output: Writable; homeDir: string; profileId: string; version: string;
    readWork?: (signal: AbortSignal) => Promise<WorkState>;
    readState?: (signal: AbortSignal) => Promise<BootstrapState> }) {
    this.server = new StdioControlServer({ ...options, events: ['work.changed', 'activity.appended', 'attention.changed', 'control.ready', 'service.warning', 'service.shutdown'], handlers: {
      ...Object.fromEntries(['approvals.resolve', 'tasks.pause', 'tasks.resume', 'tasks.cancel', 'tasks.retry', 'tasks.guide', 'sessions.start', 'sessions.resume', 'sessions.send', 'sessions.cancelTurn', 'operations.inspect'].map((method) =>
        [method, async (request: SessionMutationRequest, signal: AbortSignal) => ({ result: await sessionControl(this.options, request, signal) })])),
      'models.fallbacks': async()=>({result:await this.modelSetup.fallbacks()}),
      'models.reviewFallback': async(request)=>{if(request.method!=='models.reviewFallback')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.review(request.params,'fallback')};},
      'models.reviewFallbackOrder': async(request)=>{if(request.method!=='models.reviewFallbackOrder')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.reviewFallbackOrder(request.params)};},
      'models.reviewPrimary': async(request) => {if(request.method!=='models.reviewPrimary')throw new ControlProtocolError('-32601');return {result:await this.modelSetup.review(request.params)};},
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
      'inbox.list': (request) => {
        if (request.method !== 'inbox.list') throw new ControlProtocolError('-32601');
        const snapshot = this.workSnapshot();
        return { result: snapshot.page('inbox', snapshot.state.inbox ?? [], request.params) };
      },
      'work.list': (request) => {
        if (request.method !== 'work.list') throw new ControlProtocolError('-32601');
        const snapshot = this.workSnapshot();
        return { result: snapshot.page('work', snapshot.state.work, request.params) };
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
    this.candidates = new CredentialCandidates(this.server.profileId,this.server.instanceId);
    this.modelSetup = new ModelSetup(this.options,this.candidates,async()=>{this.#catalog=undefined;this.subscriptions.publish({type:'service.warning',payload:{reason:'configuration_changed'}});
      try {await notifyPrivateConfigurationChanged({directory:resolveProfileStateHome(this.options).gatewayStatePath,profileId:this.options.profileId,version:this.options.version,signal:AbortSignal.timeout(2000)});}catch{/* An absent owner will load the committed configuration on its next startup. */}
    });
    this.verifier = new CandidateVerifier(this.candidates);
    this.server.onDispose(() => {this.modelSetup.dispose();this.verifier.dispose();this.candidates.dispose();});
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
