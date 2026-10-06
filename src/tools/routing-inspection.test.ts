import { expect, it } from 'vitest';
import { inspectRouting } from './routing-inspection.js';
import type { SessionEvent } from '../contracts/session.js';

it('keeps stages scoped to the requested turn and distinguishes missing historical evidence',()=>{
 const events:SessionEvent[]=[{kind:'routing-status',turnMessageId:'old',stage:'capabilities',configuredMode:'jev-assisted',actualEngine:'standard',fallbackReason:'uncertain'},
 {kind:'routing-status',turnMessageId:'new',stage:'intent-skills',configuredMode:'standard',actualEngine:'standard'}];
 expect(inspectRouting(events).stages.map(s=>s.stage)).toEqual(['intent-skills']);
 expect(inspectRouting(events,{turnId:'absent'}).state).toBe('unknown');
 expect(inspectRouting(events,{turnId:'old'}).stages[0]).toMatchObject({contacted:'unknown',evidenceAvailable:false});
});
it('pages evidence while preserving service failure separately from individual uncertainty',()=>{
 const events:SessionEvent[]=[{kind:'routing-status',turnMessageId:'turn',stage:'capabilities',configuredMode:'jev-assisted',actualEngine:'jev',partialFallback:true,fallbackReason:'billing-rejected',diagnostics:{contacted:true,failure:{code:'billing-rejected',httpStatus:402},batches:[{index:0,state:'failed',questionIds:['q0'],failure:{code:'billing-rejected',httpStatus:402}}],candidates:Array.from({length:25},(_,i)=>({id:`tool:${i}`,questionId:`q${i}`,outcome:'missing',source:'standard'}))}}];
 expect(inspectRouting(events)).not.toHaveProperty('candidates');
 const first=inspectRouting(events,{details:true});expect(first.candidates).toHaveLength(20);expect(first.nextOffset).toBe(20);
 expect(first.stages[0].summary).toContain('partial Standard fallback');expect(first.stages[0].failure?.httpStatus).toBe(402);
 expect(inspectRouting(events,{details:true,offset:20}).candidates).toHaveLength(5);
});

it('does not combine unscoped legacy routing events into a current turn',()=>{
 expect(inspectRouting([{kind:'routing-status',stage:'capabilities',configuredMode:'standard',actualEngine:'standard'}]).state).toBe('unknown');
});
