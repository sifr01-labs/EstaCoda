import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { negotiateControl, failureEnvelope, type InitializeParams } from '@estacoda/control-protocol';
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

it('keeps long target mutations connected while serving ordinary control requests',async()=>{
 vi.useFakeTimers();const input=new PassThrough(),output=new PassThrough(),client=new ProtocolClient(input,output);
 const frames:any[]=[];input.on('data',chunk=>frames.push(JSON.parse(chunk.toString())));
 client.context={profileId:'p',instanceId:'s',capabilities:{methods:['targets.create','targets.inspectOperation'],events:[]}};
 try{
  const pending=client.request('targets.create',{reviewId:'review',source:{targetId:'target',targetGeneration:1},trustNewPath:true});
  const rejected=expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(16_000);expect(client.context).not.toBeNull();
  const inspection=client.request('targets.inspectOperation',{operationId:'op'});
  output.write(JSON.stringify({jsonrpc:'2.0',id:frames[1].id,result:{operationId:'op',action:'create',state:'uncertain',target:null}})+'\n');
  expect((await inspection).state).toBe('uncertain');
  await vi.advanceTimersByTimeAsync(105_000);await rejected;expect(client.context).toBeNull();
 }finally{client.dispose();vi.useRealTimers();}
});

it('keeps the connection usable after a bounded target read timeout',async()=>{
 const {client,output,requests}=pair();
 client.context={profileId:'p',instanceId:'s',capabilities:{methods:['targets.list'],events:[]}};
 const pending=client.request('targets.list',{}),rejected=expect(pending).rejects.toThrow();
 output.write(JSON.stringify(failureEnvelope(requests[0]!.id as string,'-32010'))+'\n');
 await rejected;expect(client.context).not.toBeNull();
 const next=client.request('targets.list',{});
 output.write(JSON.stringify({jsonrpc:'2.0',id:requests[1]!.id,result:{items:[],truncated:false}})+'\n');
 expect((await next).items).toEqual([]);client.dispose();
});
