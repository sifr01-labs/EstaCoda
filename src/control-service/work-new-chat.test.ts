import {it,expect} from 'vitest';
import {WorkSnapshot} from './work-snapshot.js';
import type {WorkProjection} from '../contracts/desktop-control/index.js';
const work=(id:string):WorkProjection=>({id,canonicalId:id,profileId:'one',kind:'session',status:'draft',title:id,updatedAt:1,target:null});
it('resolves a new chat and its activity without invalidating existing list cursors',async()=>{
 const snapshot=new WorkSnapshot({work:[work('old'),work('older')],activity:{}},{homeDir:'/tmp',profileId:'one'});
 const page=snapshot.search({limit:1});expect(()=>snapshot.get('new')).toThrow();
 snapshot.includeNew('new',{work:[work('new')],activity:{new:[{kind:'message',id:'message',workId:'new',profileId:'one',sequence:0,timestamp:1,role:'user',text:'First message'}]}});
 snapshot.includeNew('new',{work:[{...work('new'),title:'Competing capture'}],activity:{}});
 expect(snapshot.get('new').title).toBe('new');expect((await snapshot.activity('new',{limit:100})).items).toHaveLength(1);
 expect(snapshot.search({limit:1,cursor:page.nextCursor!}).items[0]!.id).toBe('older');
 expect(()=>snapshot.includeNew('foreign',{work:[{...work('foreign'),profileId:'two'}],activity:{}})).toThrow();
});

import {PassThrough} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {DesktopBridge} from './bridge.js';
import {CONTROL_METHODS} from '../contracts/desktop-control/index.js';
it('reads a just-created chat through the bridge before the cached list refreshes',async()=>{
 const input=new PassThrough(),output=new PassThrough();let fresh=false;const replies=new Map<string,any>();let buffer='';output.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(value.id)replies.set(value.id,value);}});
 const bridge=new DesktopBridge({input,output,homeDir:'/unused',profileId:'one',version:'test',readState:async()=>({profile:{id:'one',label:'one',configuration:'unconfigured'},runtime:{state:'stopped'}}),readWork:async()=>({work:fresh?[work('new')]:[],activity:{new:[]}})});
 const rpc=async(id:string,method:string,params:unknown)=>{input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');for(let i=0;i<100&&!replies.has(id);i++)await setImmediate();expect(replies.has(id)).toBe(true);return replies.get(id);};
 try{await rpc('init','control.initialize',{protocolVersion:{major:1,minor:0},clientVersion:'test',profileId:'one',capabilities:{methods:[...CONTROL_METHODS],events:[]}});await bridge.bootstrap(new AbortController().signal);fresh=true;
 expect((await rpc('get','work.get',{workId:'new'})).result.id).toBe('new');expect((await rpc('activity','work.activity',{workId:'new',limit:100})).result.items).toEqual([]);
 expect((await rpc('missing','work.get',{workId:'missing'})).error.code).toBe(-32003);
 }finally{bridge.server.close();await bridge.server.done;}
});
