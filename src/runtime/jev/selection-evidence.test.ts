import { expect, it } from 'vitest';
import { resolveJevSelection } from './selection-evidence.js';
import type { JevDecisionResult } from './types.js';
const result = (extra: Partial<JevDecisionResult> = {}): JevDecisionResult => ({schemaVersion:1,status:'partial',configurationRevision:'c',catalogRevision:'s',models:['jev-1.13.0'],answers:[{id:'a',type:'noul',status:'accepted',probability:.95},{id:'b',type:'noul',status:'uncertain',probability:.5}],usage:{} as JevDecisionResult['usage'],usageEntries:[],...extra});
const candidates=[{id:'tool:a',questionId:'a',standard:false},{id:'tool:b',questionId:'b',standard:true}];
it.each(['timeout','cancelled','stale','accounting-failed'] as const)('discards prior answers on %s',code=>{
 const selection=resolveJevSelection(result({failure:{code}}),candidates);
 expect(selection.actualEngine).toBe('standard');expect(selection.partialFallback).toBeUndefined();
 expect(selection.selections.map(s=>s.selected)).toEqual([false,true]);expect(selection.diagnostics.failure?.code).toBe(code);
 expect(selection.diagnostics.candidates.every(c=>c.outcome==='discarded')).toBe(true);
});
it('keeps service error distinct from candidate uncertainty',()=>{
 const selection=resolveJevSelection(result({failure:{code:'billing-rejected',httpStatus:402}}),candidates);
 expect(selection).toMatchObject({actualEngine:'jev',partialFallback:true,fallbackReason:'billing-rejected'});
 expect(selection.diagnostics.candidates[1]).toMatchObject({outcome:'uncertain',source:'standard',probability:.5});
});
it('rejects unknown IDs from injected adapters instead of accepting a partial forged map',()=>{
 expect(resolveJevSelection(result({answers:[...result().answers,{id:'forged',type:'noul',status:'accepted',probability:1}]}),candidates).actualEngine).toBe('standard');
});
it('bounds diagnostics on oversized catalogs and reports truncation',()=>{
 const selection=resolveJevSelection(result({failure:{code:'invalid-request'}}),Array.from({length:2200},(_,i)=>({id:`tool:${i}`,questionId:`q${i}`,standard:false})));
 expect(selection.diagnostics.candidates).toHaveLength(2048);expect(selection.diagnostics).toMatchObject({candidateCount:2200,truncatedCandidates:true});
});
