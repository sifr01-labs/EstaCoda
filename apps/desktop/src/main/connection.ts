import { EventEmitter } from 'node:events';
import { CONTROL_METHODS,type MethodContracts,CONTROL_EVENTS, DESKTOP_PROTOCOL_VERSION, type BootstrapResult, type ControlEvent, type WorkProjection, type InboxProjection, type Page, type ActivityProjection } from '@estacoda/control-protocol';
import { ProtocolClient } from './protocol-client.js';
import { ServiceProcess, validateProfileId } from './service-process.js';
export type ConnectionState = { status: 'connecting' | 'ready' | 'disconnected' | 'incompatible' | 'unavailable'; generation: number;
  profileId: string; bootstrap: BootstrapResult | null; work: Page<WorkProjection>; inbox: Page<InboxProjection> };
export const MODEL_METHODS=CONTROL_METHODS.filter(method=>method.startsWith('models.') || ['providers.list','sessions.setModel','tasks.setModel','operations.inspect'].includes(method));
export const WORK_METHODS=CONTROL_METHODS.filter(method=>method==='inbox.get'||method==='work.targets'||method==='work.live'||method.startsWith('sessions.')||method.startsWith('tasks.')||method==='approvals.resolve'||method==='operations.inspect');
export class DesktopConnection extends EventEmitter {
  #client: ProtocolClient | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true; #attempt = 0; #refreshing = false; #refreshAgain = false;
  state: ConnectionState = { status: 'connecting', generation: 0, profileId: 'default', bootstrap: null, work: {items:[],nextCursor:null}, inbox: {items:[],nextCursor:null} };
  constructor(readonly service: ServiceProcess) { super(); service.on('disconnected', () => this.lost()); }
  switchProfile(profileId: string): void {
    validateProfileId(profileId); this.close(); this.#stopped = false; this.#attempt = 0;
    this.state = { status: 'connecting', generation: this.state.generation + 1, profileId, bootstrap: null, work: {items:[],nextCursor:null}, inbox: {items:[],nextCursor:null} };
    this.publish(); void this.connect();
  }
  private publish(): void { this.emit('state', structuredClone(this.state)); }
  private async connect(): Promise<void> {
    const generation = this.state.generation;
    try {
      const transport = this.service.start(this.state.profileId);
      this.emit('credentials', transport.credentials);
      const client = new ProtocolClient(transport.input, transport.output); this.#client = client;
      client.on('disconnected', () => { if (client === this.#client) this.lost(); });
      client.on('resync', () => { if (client === this.#client) void this.refresh(); });
      client.on('event', (event: ControlEvent) => {
        if (client !== this.#client) return;
        if (event.type === 'service.shutdown') this.lost();
        else if (event.type !== 'control.ready') void this.refresh();
      });
      await client.request('control.initialize', { profileId: this.state.profileId, clientVersion: '0.0.0', protocolVersion: DESKTOP_PROTOCOL_VERSION,
        capabilities: { methods: ['control.bootstrap','control.subscribe','control.unsubscribe','work.list','work.get','work.activity','inbox.list',...new Set([...MODEL_METHODS,...WORK_METHODS])], events: [...CONTROL_EVENTS] } });
      if (generation !== this.state.generation) return;
      await this.refresh(); if(client===this.#client&&this.state.status==='ready')this.#attempt = 0;
    } catch (error) {
      if (generation !== this.state.generation) return;
      if (error && typeof error === 'object' && 'code' in error && error.code === '-32001') this.lost('incompatible');
      else this.lost('unavailable');
    }
  }
  private async refresh(): Promise<void> {
    if (this.#refreshing) { this.#refreshAgain = true; return; }
    const client = this.#client; if (!client?.context || this.#stopped) return;
    this.#refreshing = true;
    try {
      do {
        this.#refreshAgain = false;
        const bootstrap = await client.request('control.bootstrap', {});
        // Rebuild the inspected extent with fresh cursors; never append stale pages.
        const [work, inbox] = await Promise.all([
          this.readWork(client, Math.max(100, this.state.work.items.length)),
          this.readInbox(client, Math.max(100, this.state.inbox.items.length)),
        ]);
        const sub = await client.request('control.subscribe', {after:bootstrap.cursor, events:client.context!.capabilities.events});
        if (client !== this.#client) return;
        if (sub.state !== 'subscribed') throw new Error();
        this.state = {...this.state, status:'ready', bootstrap, work, inbox}; this.publish();
      } while (this.#refreshAgain && client === this.#client);
    } catch { if (client === this.#client) this.lost('unavailable'); }
    finally { this.#refreshing = false; if (this.#refreshAgain && !this.#stopped) { this.#refreshAgain = false; void this.refresh(); } }
  }
  private async readWork(client: ProtocolClient, count: number): Promise<Page<WorkProjection>> {
    const result = await client.request('work.list', {limit: 100});
    while (result.nextCursor && result.items.length < Math.min(count, 2000)) {
      const page = await client.request('work.list', {limit: 100, cursor: result.nextCursor});
      result.items.push(...page.items); result.nextCursor = page.nextCursor;
    }
    return result;
  }
  private async readInbox(client: ProtocolClient, count: number): Promise<Page<InboxProjection>> {
    const result = await client.request('inbox.list', {limit: 100});
    while (result.nextCursor && result.items.length < Math.min(count, 2000)) {
      const page = await client.request('inbox.list', {limit: 100, cursor: result.nextCursor});
      result.items.push(...page.items); result.nextCursor = page.nextCursor;
    }
    return result;
  }
  async more(kind:'work'|'inbox'):Promise<void> {
    const client=this.#client, previous=this.state, cursor=this.state[kind].nextCursor;
    if(!client||this.state.status!=='ready'||!cursor||this.#refreshing)throw new Error('Snapshot unavailable.');
    if(this.state[kind].items.length>=2000)throw new Error('Inspection limit reached.');
    if(kind==='work'){
      const page=await client.request('work.list',{limit:100,cursor});
      if(client!==this.#client||this.state!==previous)throw new Error('Snapshot changed.');
      this.state={...this.state,work:{items:[...previous.work.items,...page.items],nextCursor:page.nextCursor}};
    }else{
      const page=await client.request('inbox.list',{limit:100,cursor});
      if(client!==this.#client||this.state!==previous)throw new Error('Snapshot changed.');
      this.state={...this.state,inbox:{items:[...previous.inbox.items,...page.items],nextCursor:page.nextCursor}};
    }
    this.publish();
  }
  async modelRequest<M extends keyof MethodContracts>(method:M,params:MethodContracts[M]['params']):Promise<MethodContracts[M]['result']>{
    const client=this.#client,generation=this.state.generation;
    if(!client || this.state.status!=='ready' || !MODEL_METHODS.includes(method))throw new Error('Models unavailable.');
    const result=await client.request(method,params);
    if(client!==this.#client || generation!==this.state.generation)throw new Error('Desktop context changed.');
    return result;
  }
  async workRequest<M extends keyof MethodContracts>(method:M,params:MethodContracts[M]['params']):Promise<MethodContracts[M]['result']>{
    const client=this.#client,generation=this.state.generation;
    if(!client||this.state.status!=='ready'||!WORK_METHODS.includes(method))throw new Error('Work unavailable.');
    const result=await client.request(method,params);
    if(client!==this.#client||generation!==this.state.generation)throw new Error('Desktop context changed.');return result;
  }
  async search(query:string,cursor?:string,parentWorkId?:string):Promise<Page<WorkProjection>> {
    const client=this.#client,generation=this.state.generation;
    if(!client||this.state.status!=='ready')throw new Error('Work unavailable.');
    const result=await client.request('work.list',{query,limit:50,...(cursor?{cursor}:{}),...(parentWorkId?{parentWorkId}:{})});
    if(client!==this.#client||generation!==this.state.generation)throw new Error('Desktop context changed.');
    return result;
  }
  async getWork(workId: string): Promise<WorkProjection> {
    const client = this.#client, generation = this.state.generation;
    if (!client || this.state.status !== 'ready') throw new Error('Runtime disconnected.');
    const work = await client.request('work.get', {workId});
    if (client !== this.#client || generation !== this.state.generation) throw new Error('Desktop context changed.');
    return work;
  }
  async activity(workId: string, cursor?: string): Promise<Page<ActivityProjection>> {
    const client = this.#client, generation = this.state.generation;
    if (!client || this.state.status !== 'ready') throw new Error('Runtime disconnected.');
    const page = await client.request('work.activity', {workId, limit:100, ...(cursor ? {cursor} : {})});
    if (client !== this.#client || generation !== this.state.generation) throw new Error('Desktop context changed.');
    return page;
  }
  private lost(status: ConnectionState['status'] = 'disconnected'): void {
    if (this.#stopped || this.#timer) return;
    this.#client?.dispose(); this.#client = null; this.service.stop(); this.emit('invalidate');
    this.state = {...this.state, generation:this.state.generation+1, status, bootstrap:null, work:{items:[],nextCursor:null}, inbox:{items:[],nextCursor:null}}; this.publish();
    if (status === 'incompatible') return;
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.connect(); }, Math.min(30_000, 500 * 2 ** this.#attempt++));
  }
  close(): void {
    this.#stopped = true; clearTimeout(this.#timer); this.#timer = undefined;
    this.#client?.dispose(); this.#client = null; this.service.stop(); this.emit('invalidate');
  }
}
