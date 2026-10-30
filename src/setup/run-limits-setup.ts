import type { Prompt } from '../cli/prompt-contract.js';
import type { SetupCopyLocale } from './setup-copy.js';
import { promptSetupChoice, setupPromptContext } from './setup-prompts.js';
import { normalizeRunLimits, type RunLimitsConfig, type AgentRunLimits } from '../config/run-limits.js';

/** Collect only; the shared reviewed settings apply owns persistence. */
export async function promptRunLimitsSetup(prompt: Prompt, locale: SetupCopyLocale, current?: RunLimitsConfig) {
  const context = setupPromptContext(prompt, locale);
  const ar = locale === 'ar', limits = normalizeRunLimits(current);
  const scope = await promptSetupChoice(context, { title: ar ? 'حدود تشغيل الوكيل' : 'Agent run limits',
    message: ar ? 'تسري الحدود على العمل الجديد. تبقى حدود الإنفاق والموافقات وحماية التعثر فعالة.' : 'Limits apply to new work. Spending limits, approvals, and stall protection remain active.',
    defaultValue: 'interactive', choices: [
      {id:'interactive',value:'interactive',label:ar?'العمل التفاعلي':'Interactive work'},
      {id:'unattended',value:'unattended',label:ar?'العمل المفوض وغير المراقب':'Delegated & unattended work'},
      {id:'back',value:'back',label:ar?'رجوع':'Back'}] });
  if (scope === 'back') return;
  const selected = scope as 'interactive' | 'unattended';
  if (selected === 'interactive') {
    const mode = await promptSetupChoice(context, {title:ar?'العمل التفاعلي':'Interactive work', message:ar?'اختر حدود التشغيل.':'Choose run limits.', defaultValue: Object.values(limits.interactive).every(n=>n===0)?'unlimited':'custom', choices:[
      {id:'unlimited',value:'unlimited',label:ar?'حتى الاكتمال':'Until complete'},
      {id:'custom',value:'custom',label:ar?'حدود مخصصة':'Custom limits'},
      {id:'back',value:'back',label:ar?'رجوع':'Back'}]});
    if(mode==='back')return;
    if(mode==='unlimited')return runLimitReview('interactive',{maxDurationMinutes:0,maxIterations:0,maxToolCalls:0},ar);
  }
  const selectedLimits={...limits[selected]};
  for(const [key,en,arabic] of [
    ['maxDurationMinutes','Run duration (minutes)','مدة التشغيل (دقائق)'],
    ['maxIterations','Model steps','خطوات النموذج'],
    ['maxToolCalls','Tool calls','استدعاءات الأدوات']
  ] as const){
    let value:number;
    for(;;){
      const answer=await prompt(`${ar?arabic:en} [${limits[selected][key]}]: `,{description:ar?(selected==='interactive'?'صفر يعني بلا حد. اتركه فارغًا للاحتفاظ بالقيمة.':'أدخل عددًا صحيحًا موجبًا. اتركه فارغًا للاحتفاظ بالقيمة.'):(selected==='interactive'?'0 means unlimited. Leave blank to keep the current value.':'Enter a positive whole number. Leave blank to keep the current value.')});
      value=answer.trim()===''?limits[selected][key]:Number(answer);
      try{normalizeRunLimits({[selected]:{[key]:value}});break;}catch{await promptSetupChoice(context,{title:ar?'قيمة غير صالحة':'Invalid limit',message:ar?'أدخل عددًا صحيحًا ضمن الحدود المدعومة.':'Enter a whole number within the supported limits.',defaultValue:'retry',choices:[{id:'retry',value:'retry',label:ar?'إعادة المحاولة':'Try again'}]});}
    }
    selectedLimits[key]=value;
  }
  return runLimitReview(selected,selectedLimits,ar);
}

function runLimitReview(scope:'interactive'|'unattended',limits:AgentRunLimits,ar:boolean){
 const display=(n:number)=>n===0?(ar?'بلا حد':'No limit'):String(n);
 return {runScope:scope,scope:scope==='interactive'?(ar?'تفاعلي':'Interactive'):(ar?'دون إشراف':'Unattended'),maxDurationMinutes:limits.maxDurationMinutes,maxIterations:limits.maxIterations,maxToolCalls:limits.maxToolCalls,duration:display(limits.maxDurationMinutes),iterations:display(limits.maxIterations),toolCalls:display(limits.maxToolCalls)};
}
