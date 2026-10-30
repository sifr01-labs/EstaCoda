import {expect,it} from 'vitest';
import {formatRunLimitStop,runLimitStop} from './run-limit-receipt.js';
const limits={maxProviderIterations:45,maxProviderToolCalls:100,maxProviderWallClockMs:1800000};
it('distinguishes operator ceilings from internal recovery and cancellation stops',()=>{
 expect(runLimitStop('budget_exhausted',limits,{iterations:45,toolCalls:44,elapsedMs:1000})).toEqual({kind:'model-steps',limit:45,used:45});
 expect(runLimitStop('budget_exhausted',limits,{iterations:40,toolCalls:100,elapsedMs:1000})?.kind).toBe('tool-calls');
 expect(runLimitStop('deadline_reached',limits,{iterations:40,toolCalls:90,elapsedMs:1790000})?.kind).toBe('duration');
 expect(runLimitStop('cancelled',limits,{iterations:45,toolCalls:100,elapsedMs:1800000})).toBeUndefined();
 expect(runLimitStop('budget_exhausted',limits,{iterations:3,toolCalls:0,elapsedMs:100})).toBeUndefined();
});
it('never serializes an unlimited ceiling as a budget stop',()=>{
 expect(runLimitStop('budget_exhausted',{maxProviderIterations:Infinity,maxProviderToolCalls:Infinity,maxProviderWallClockMs:Infinity},{iterations:200,toolCalls:200,elapsedMs:7200000})).toBeUndefined();
});
it('makes foreground renewal explicit and keeps durable Task budgets cumulative',()=>{
 const stop={kind:'model-steps' as const,limit:45,used:45};
 expect(formatRunLimitStop(stop,'en',false)).toContain('Send Continue to start another turn with the saved limits');
 expect(formatRunLimitStop(stop,'en',true)).toContain('Resuming does not replenish');
 expect(formatRunLimitStop(stop,'en',true)).not.toContain('Send Continue');
 expect(formatRunLimitStop(stop,'ar',false)).toContain('\u206645\u2069');
});
