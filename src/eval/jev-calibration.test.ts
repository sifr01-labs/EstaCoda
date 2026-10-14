import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {scoreSelection,summarizeSelections,validateCalibrationCorpus,probabilityCalibration,type JevCalibrationCase} from './jev-calibration.js';
const row:JevCalibrationCase={id:'test',family:'test',split:'development',language:'en',prompt:'Read a file.',required:{intents:['repo-inspection'],skills:[],tools:[['file.read','alternative.read']]},acceptable:{intents:[],skills:[],tools:['file.glob']}};
describe('Jev calibration scoring',()=>{
 it('accepts alternative implementations without counting optional tools as requirements',()=>{
  const score=scoreSelection(row,{intents:['repo-inspection'],skills:[],tools:['alternative.read','file.glob','file.write']});
  expect(score.tools).toMatchObject({required:1,met:1,missing:[],irrelevant:['file.write']});
 });
 it('does not let correct negatives or recovery inflate required recall',()=>{
  const summary=summarizeSelections([{row,selected:{intents:[],skills:[],tools:['capability.discover','config.provider.execution_status']}}]);
  expect(summary.tools).toMatchObject({required:1,met:0,recall:0,irrelevantSelections:0});
  expect(scoreSelection(row,{intents:[],skills:[],tools:['file.read','file.read']}).tools.selected).toBe(1);
 });
 it('rejects duplicate cases and family leakage',()=>{
  expect(()=>validateCalibrationCorpus([row,row])).toThrow('Duplicate');
  expect(()=>validateCalibrationCorpus([row,{...row,id:'other',split:'acceptance'}])).toThrow('crosses');
 });
 it('validates the frozen corpus and gives all splits meaningful coverage',()=>{
  const corpus=JSON.parse(readFileSync(new URL('../../assets/evals/jev-routing-v1.json',import.meta.url),'utf8'));
  expect(()=>validateCalibrationCorpus(corpus.cases)).not.toThrow();
  for(const split of ['development','calibration','acceptance'])expect(corpus.cases.filter((r:JevCalibrationCase)=>r.split===split)).toHaveLength(20);
 });
});


it('reports probability calibration without scoring optional candidates as false positives',()=>{
 const result=probabilityCalibration([{row,candidates:[{stage:'intents',id:'repo-inspection',probability:.9,status:'accepted'},{stage:'intents',id:'research',probability:.9,status:'accepted'},{stage:'tools',id:'file.glob',probability:.9,status:'accepted'},{stage:'tools',id:'file.read',probability:.5,status:'uncertain'}]}]);
 expect(result.intents).toMatchObject({positiveCount:1,negativeCount:1});
 expect(result.tools).toMatchObject({positiveCount:0,negativeCount:0,unresolved:1});
});
