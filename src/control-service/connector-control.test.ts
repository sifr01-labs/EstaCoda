import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {connectorControl} from './connector-control.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
const control=vi.hoisted(()=>({call:vi.fn()}));
vi.mock('../gateway/private-control.js',()=>({callPrivateControl:control.call}));
vi.mock('./browser-view.js',()=>({browserOwner:async(input:any,work:any)=>{if(input.profileId!==work.profileId)throw new Error('Profile mismatch');return{id:'s',executionTarget:work.target};}}));
it('shows only safe selected-profile connector metadata and forwards a bounded reconnect',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-connectors-'),input={homeDir,profileId:'p',version:'test'},paths=resolveProfileStateHome(input),signal=new AbortController().signal;
 const work={kind:'session',profileId:'p',target:{targetId:'t',targetGeneration:1}} as any;
 try {
  await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({mcpServers:{alpha:{command:'private-command',env:{PRIVATE_KEY:'synthetic-secret'}},beta:{enabled:false,command:'disabled'}}}));
  control.call.mockReset();
  expect(await connectorControl(input,undefined,'inspect',signal)).toEqual({state:'not_loaded',items:[{id:'alpha',state:'not_loaded',toolCount:0},{id:'beta',state:'disabled',toolCount:0}]});expect(control.call).not.toHaveBeenCalled();
  control.call.mockResolvedValue({state:'ready',servers:[{name:'alpha',enabled:true,available:true,connected:true,toolCount:2,error:'synthetic-secret',tools:['private-tool']}]});
  expect(await connectorControl(input,work,'inspect',signal)).toMatchObject({state:'ready',items:[{id:'alpha',state:'ready',toolCount:2},{id:'beta',state:'disabled',toolCount:0}]});
  expect(control.call.mock.calls.at(-1)![0]).not.toHaveProperty('startIfNeeded');
  control.call.mockResolvedValue({state:'reconnecting',servers:null});
  await connectorControl(input,work,'reconnect',signal);
  expect(control.call.mock.calls.at(-1)![0]).toMatchObject({profileId:'p',startIfNeeded:{homeDir},requireTargetGeneration:true,request:{method:'mcp.control',connectorAction:'reconnect',sessionId:'s',targetId:'t',targetGeneration:1}});
  await expect(connectorControl({...input,profileId:'other'},work,'reconnect',signal)).rejects.toThrow('Profile');
  control.call.mockRejectedValue(new Error('private-command synthetic-secret'));
  expect(await connectorControl(input,work,'inspect',signal)).toMatchObject({state:'unavailable'});
  await expect(connectorControl(input,undefined,'reconnect',signal)).rejects.toThrow('Select a chat');
 } finally {await rm(homeDir,{recursive:true,force:true});}
});
