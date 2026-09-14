import type { Duplex } from 'node:stream';
import { ControlProtocolError, exactKeys, failureEnvelope, isControlId, parseControlFrame, serializeControlFrame, type JsonValue } from '../contracts/desktop-control/index.js';
import { CredentialCandidates, validateCandidateScope } from './credential-candidates.js';
import { BoundedLines } from './framing.js';
/** Dedicated inherited descriptor, never stdout or an ordinary preload/RPC route. */
export function attachCredentialPipe(pipe: Duplex, candidates: CredentialCandidates, onClosed: () => void, browserDeliver?:(params:unknown,signal:AbortSignal)=>Promise<void>, workInput?:(params:unknown,signal:AbortSignal)=>Promise<import('../contracts/desktop-control/work-input.js').WorkInputResult>): () => void {
  let closed = false,browserBusy=false,workBusy=0;const abort=new AbortController();
  const close = () => {
    if (closed) return; closed = true; abort.abort(); lines.dispose(); candidates.dispose(); pipe.destroy(); onClosed();
  };
  const send = (id: string, result: JsonValue) => {
    if (pipe.writableLength > 65_536) { close(); return; }
    pipe.write(serializeControlFrame({ jsonrpc: '2.0', id, result }));
  };
  const lines = new BoundedLines(65_536, (frame) => {
    let id: string | null = null;
    try {
      const message = parseControlFrame(frame);
      if (!('method' in message) || !('id' in message)) throw new ControlProtocolError('-32600');
      id = message.id;
      const params = message.params;
      if(message.method==='credentials.workInput'){
        if(!workInput)throw new ControlProtocolError('-32601');
        if(workBusy>=8)throw new ControlProtocolError('-32009');workBusy++;
        void workInput(params,abort.signal).then(result=>{if(!closed)send(id!,result);},()=>{if(!closed)pipe.write(serializeControlFrame(failureEnvelope(id,'-32003')));}).finally(()=>{workBusy--;});
      } else if(message.method==='credentials.browserDeliver'){
        if(!browserDeliver||browserBusy)throw new ControlProtocolError('-32009');
        browserBusy=true;
        void browserDeliver(params,abort.signal).then(()=>{if(!closed)send(id!,{delivered:true});},()=>{if(!closed)pipe.write(serializeControlFrame(failureEnvelope(id,'-32003')));}).finally(()=>{browserBusy=false;});
      } else if (message.method === 'credentials.stage') {
        if (!exactKeys(params, ['scope', 'value']) || typeof params.value !== 'string') throw new ControlProtocolError('-32602');
        validateCandidateScope(params.scope);
        const candidateId = candidates.stage(params.scope, params.value);
        send(id, { candidateId });
      } else if (message.method === 'credentials.discard') {
        if (!exactKeys(params, ['scope', 'candidateId']) || !isControlId(params.candidateId)) throw new ControlProtocolError('-32602');
        validateCandidateScope(params.scope); candidates.discard(params.candidateId, params.scope); send(id, { discarded: true });
      } else if (message.method === 'credentials.closeWindow') {
        if (!exactKeys(params, ['windowId', 'generation']) || !isControlId(params.windowId) || typeof params.generation !== 'number') throw new ControlProtocolError('-32602');
        candidates.closeWindow(params.windowId, params.generation); send(id, { closed: true });
      } else throw new ControlProtocolError('-32601');
    } catch (error) {
      if (pipe.writableLength > 65_536) { close(); return; }
      pipe.write(serializeControlFrame(failureEnvelope(id, error instanceof ControlProtocolError ? error.code : '-32603')));
    }
  }, close);
  pipe.on('data', (chunk: Buffer) => { if (Buffer.isBuffer(chunk)) lines.push(chunk); else close(); });
  pipe.on('end', close).on('error', close).on('close', close);
  return close;
}
