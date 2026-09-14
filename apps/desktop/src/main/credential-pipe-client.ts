import {validateWorkInputResult,type WorkInputCommand,type WorkInputResult} from '@estacoda/control-protocol';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { exactKeys, isControlId, isRecord, parseControlFrame, serializeControlFrame, type JsonValue } from '@estacoda/control-protocol';
export type CredentialScope = { windowId: string; generation: number; purpose: 'provider' | 'telegram' | 'settings'; providerId: string; authMethod: 'api_key' | 'oauth'; endpoint: string };
/** Private fd3 only. Never forwards transport errors, values or frames to logging. */
export class CredentialPipeClient {
  #buffer = Buffer.alloc(0); #closed = false;
  #pending = new Map<string, { method: string; resolve: (value: Record<string, JsonValue>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly pipe: Duplex) {
    pipe.on('data', this.receive); pipe.once('error', this.dispose); pipe.once('close', this.dispose); pipe.once('end', this.dispose);
  }
  async workInput(workId:string,command:WorkInputCommand):Promise<WorkInputResult>{try{const result=await this.request('credentials.workInput',{workId,command});validateWorkInputResult(result);return result;}finally{if(command.action==='deliver')command.value='';}}
  async deliverBrowser(params:{workId:string;command:Extract<import('@estacoda/control-protocol').HumanBrowserCommand,{action:'signin-deliver'}>}):Promise<void>{
    try{await this.request('credentials.browserDeliver',params);}finally{params.command.value='';}
  }
  async stage(scope: CredentialScope, value: string): Promise<string> {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 49_152) throw new Error('Credential rejected.');
    return (await this.request('credentials.stage', { scope, value })).candidateId as string;
  }
  async closeWindow(windowId: string, generation: number): Promise<void> { await this.request('credentials.closeWindow', { windowId, generation }); }
  private request(method: string, params: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
    if (this.#closed || this.#pending.size >= 8 || this.pipe.writableLength > 65_536) return Promise.reject(new Error('Credential channel unavailable.'));
    const id = randomUUID();
    const frame = serializeControlFrame({jsonrpc:'2.0', id, method, params});
    if (Buffer.byteLength(frame) > 65_536) return Promise.reject(new Error('Credential rejected.'));
    return new Promise((resolve,reject) => {
      const timer = setTimeout(this.dispose, 15_000); timer.unref();
      this.#pending.set(id,{method,resolve,reject,timer}); this.pipe.write(frame);
    });
  }
  private receive = (chunk: Buffer): void => {
    if (this.#closed) return;
    try {
      if (!Buffer.isBuffer(chunk)) throw new Error();
      let offset=0;
      while(offset<chunk.length) {
        const newline=chunk.indexOf(10,offset), end=newline<0?chunk.length:newline+1;
        if(this.#buffer.length+end-offset>65_536) throw new Error();
        this.#buffer=Buffer.concat([this.#buffer,chunk.subarray(offset,end)]);offset=end;
        if(newline<0) break;
        const response=parseControlFrame(new TextDecoder('utf-8',{fatal:true}).decode(this.#buffer));this.#buffer=Buffer.alloc(0);
        if(!('id' in response)||response.id===null||'method' in response)throw new Error();
        const pending=this.#pending.get(response.id);if(!pending)throw new Error();
        if('error' in response) { this.#pending.delete(response.id);clearTimeout(pending.timer);pending.reject(new Error('Credential rejected.'));continue; }
        const result=response.result;
        if(pending.method==='credentials.workInput'){validateWorkInputResult(result);this.#pending.delete(response.id);clearTimeout(pending.timer);pending.resolve(result as unknown as Record<string,JsonValue>);continue;}
        if(!isRecord(result) || (pending.method==='credentials.browserDeliver' ? !exactKeys(result,['delivered'])||result.delivered!==true : pending.method==='credentials.stage' ? !exactKeys(result,['candidateId'])||!isControlId(result.candidateId) : !exactKeys(result,['closed'])||result.closed!==true))throw new Error();
        this.#pending.delete(response.id);clearTimeout(pending.timer);pending.resolve(result as Record<string,JsonValue>);
      }
    }catch {this.dispose();}
  };
  dispose = (): void => {
    if(this.#closed)return;this.#closed=true;this.#buffer=Buffer.alloc(0);
    this.pipe.off('data',this.receive);this.pipe.destroy();
    for(const item of this.#pending.values()){clearTimeout(item.timer);item.reject(new Error('Credential channel unavailable.'));}
    this.#pending.clear();
  };
}
