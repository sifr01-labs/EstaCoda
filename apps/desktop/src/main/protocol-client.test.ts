import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { negotiateControl, type InitializeParams } from '@estacoda/control-protocol';
import { ProtocolClient } from './protocol-client.js';
function pair() {
  const input = new PassThrough(), output = new PassThrough();
  const client = new ProtocolClient(input, output, 100);
  const requests: Record<string, unknown>[] = [];
  input.on('data', chunk => requests.push(JSON.parse(chunk.toString())));
  return {client, input, output, requests};
}
const params: InitializeParams = {profileId:'default',clientVersion:'0.0.0',protocolVersion:{major:1,minor:0},capabilities:{methods:['control.bootstrap'],events:[]}};
describe('strict Main protocol client', () => {
  it('correlates a split initialization response and binds the negotiated profile', async () => {
    const {client, output, requests} = pair();
    const promise = client.request('control.initialize', params);
    const result = negotiateControl(params, {profileId:'default',instanceId:'service-1',serviceVersion:'0.1.0',implemented:{methods:['control.bootstrap'],events:[]}});
    const frame = JSON.stringify({jsonrpc:'2.0',id:requests[0]!.id,result})+'\n';
    output.write(frame.slice(0,12)); output.write(frame.slice(12));
    expect(await promise).toEqual(result); expect(client.context?.profileId).toBe('default'); client.dispose();
  });
  it('rejects cross-profile results and discards outstanding requests', async () => {
    const {client, output, requests} = pair();
    const rejected = expect(client.request('control.initialize', params)).rejects.toThrow();
    const result = negotiateControl({...params,profileId:'other'}, {profileId:'other',instanceId:'s',serviceVersion:'1',implemented:{methods:[],events:[]}});
    output.write(JSON.stringify({jsonrpc:'2.0',id:requests[0]!.id,result})+'\n');
    await rejected; expect(client.context).toBeNull();
  });
  it.each([Buffer.alloc(262145, 65), Buffer.from([0xff,10]), Buffer.from('{"jsonrpc":"2.0","jsonrpc":"2.0"}\n')])('closes on oversized, invalid UTF8 or ambiguous input', chunk => {
    const {client,output} = pair(); const disconnected = vi.fn(); client.on('disconnected',disconnected);
    output.write(chunk); expect(disconnected).toHaveBeenCalledOnce();
  });
  it('bounds unresolved requests and never replays after disposal', async () => {
    const {client, requests} = pair();
    const result = expect(client.request('control.initialize',params)).rejects.toThrow();
    client.dispose(); await result;
    await expect(client.request('control.initialize',params)).rejects.toThrow(); expect(requests).toHaveLength(1);
  });
});
