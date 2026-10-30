import type {ExecutionTerminationCause} from '../contracts/execution-plan.js';

export type RunLimitStop = {kind:'model-steps'|'tool-calls'|'duration';limit:number;used:number};
/** Internal retry/no-progress bounds are not operator-configured run limits. */
export function runLimitStop(cause:ExecutionTerminationCause,limits:{maxProviderIterations:number;maxProviderToolCalls:number;maxProviderWallClockMs:number},usage:{iterations:number;toolCalls:number;elapsedMs:number}):RunLimitStop|undefined{
 if(cause==='deadline_reached'&&Number.isFinite(limits.maxProviderWallClockMs))return {kind:'duration',limit:limits.maxProviderWallClockMs,used:usage.elapsedMs};
 if(cause!=='budget_exhausted')return;
 if(Number.isFinite(limits.maxProviderToolCalls)&&usage.toolCalls>=limits.maxProviderToolCalls)return {kind:'tool-calls',limit:limits.maxProviderToolCalls,used:usage.toolCalls};
 if(Number.isFinite(limits.maxProviderIterations)&&usage.iterations>=limits.maxProviderIterations)return {kind:'model-steps',limit:limits.maxProviderIterations,used:usage.iterations};
}

export function formatRunLimitStop(stop:RunLimitStop,locale:'en'|'ar',durableTask:boolean):string{
 const ar=locale==='ar',amount=stop.kind==='duration'?stop.limit/60000:stop.limit;
 const unit=stop.kind==='duration'?(ar?'دقيقة':'minutes'):stop.kind==='model-steps'?(ar?'خطوات للنموذج':'model steps'):(ar?'استدعاءات للأدوات':amount===1?'tool call':'tool calls');
 const limit=ar?`توقف التشغيل عند الحد المحدد: \u2066${amount}\u2069 ${unit}.`:`Stopped at the configured run limit: ${amount} ${unit}.`;
 const continuation=durableTask
  ? ar?'تبقى ميزانية المهمة تراكمية عبر المحاولات. الاستئناف لا يعيد تعبئتها.':'Task budgets remain cumulative across attempts. Resuming does not replenish them.'
  : ar?'أرسل «تابع» لبدء دور جديد بالحدود المحفوظة. لم تُرفع الحدود تلقائيًا. راجع الإجراءات غير المؤكدة قبل تكرارها.':'Send Continue to start another turn with the saved limits. Limits were not raised automatically. Check uncertain actions before repeating them.';
 return `${limit}\n\n${continuation}`;
}
