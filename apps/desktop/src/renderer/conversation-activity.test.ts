import {describe,it,expect} from 'vitest';
import type {ActivityProjection} from '@estacoda/control-protocol';
import {activityRuns,runContent,toolActions} from './conversation-activity.js';
const base={workId:'session:s',profileId:'p',timestamp:1,sequence:0};
const tool=(id:string,state:'running'|'completed'|'failed',callId?:string):ActivityProjection=>({...base,id,kind:'tool',name:'files.read',state,summary:'Safe summary',...(callId?{callId}:{})});
const message=(id:string,role:'user'|'assistant',phase?:'progress'|'response'):ActivityProjection=>({...base,id,kind:'message',role,text:id,...(phase?{phase}:{})});
const result:ActivityProjection={...base,id:'outcome',kind:'result',status:'completed',evidence:{state:'unverified',summary:'',artifactIds:[]},usage:{reportedTokens:null,cost:null}};
describe('conversation activity',()=>{
 it('pairs interleaved calls by identity without merging retries or legacy records',()=>{
  const actions=toolActions([tool('s1','running','one'),tool('s2','running','two'),tool('e2','completed','two'),tool('e1','failed','one'),tool('retry','completed','three'),tool('legacy-start','running'),tool('legacy-end','completed')]);
  expect(actions.map(action=>action.records.map(item=>item.id))).toEqual([['s1','e1'],['s2','e2'],['retry'],['legacy-start'],['legacy-end']]);
 });
 it('never pairs across work or profile identities',()=>{
  expect(toolActions([tool('a','running','same'),{...tool('b','completed','same'),profileId:'other'},{...tool('c','completed','same'),workId:'other'}])).toHaveLength(3);
 });
 it('retains user turns, outcome-before-answer ordering and a new resumed run',()=>{
  const runs=activityRuns([message('q','user'),tool('a','completed','one'),result,message('answer','assistant','response'),tool('resume','running','two'),message('q2','user')]);
  expect(runs.map(run=>run.id)).toEqual(['q','resume','q2']);expect(runContent(runs[0]!).responses.map(item=>item.id)).toEqual(['answer']);
 });
 it('keeps progress and every plan revision available while emphasizing the final response',()=>{
  const plan:ActivityProjection={...base,id:'plan',kind:'plan',steps:[{id:'step',title:'Read source',status:'pending'}]};
  const run=activityRuns([message('q','user'),message('progress','assistant','progress'),plan,tool('t','completed','one'),{...plan,id:'plan2',steps:[{id:'step',title:'Read source',status:'completed'}]},result,message('answer','assistant','response')])[0]!;
  expect(run.items).toHaveLength(6);expect(runContent(run).plans).toHaveLength(2);expect(runContent(run).responses.map(item=>item.id)).toEqual(['answer']);
 });
 it('does not hide message-only conversation history or label progress as a final answer',()=>{
  expect(runContent(activityRuns([message('a','assistant'),message('b','assistant')])[0]!).responses).toHaveLength(2);
  const content=runContent(activityRuns([message('a','assistant','progress'),tool('t','running','one')])[0]!);expect(content.responses).toEqual([]);expect(content.outcome).toBeUndefined();expect(content.latestProgress?.id).toBe('a');
 });
 it('deduplicates output references within a run, preserving other owners',()=>{
  const artifact:ActivityProjection={...base,id:'f',kind:'artifact',label:'a.yaml',bytes:1,mimeType:'text/yaml',reference:{source:'session',ownerId:'s',artifactId:'f'}};
  const content=runContent(activityRuns([artifact,{...artifact,id:'f2'},{...artifact,id:'f3',reference:{...artifact.reference,ownerId:'other'}}])[0]!);expect(content.outputs).toHaveLength(2);
 });
});
