import {formatRoutingCheck} from '../contracts/desktop-control/routing.js';
import type {RoutingCheckResult} from '../contracts/routing.js';
import type { Prompt } from '../cli/prompt-contract.js';
import { promptForApiKeyInput } from '../cli/secret-prompt.js';
import { JEV_MODELS, type ResolvedRoutingConfig } from '../contracts/routing.js';
import type { SetupCopyLocale } from './setup-copy.js';
import { promptSetupChoice } from './setup-prompts.js';

/** Collect only. Credentials and configuration are committed by reviewed apply. */
export async function promptRoutingModelSetup(prompt: Prompt, locale: SetupCopyLocale, current: ResolvedRoutingConfig, check?:()=>Promise<RoutingCheckResult>): Promise<{ values: Record<string, string>; pendingCredentialWrites?: Array<{envVarName: string; value: string}> } | undefined> {
  const ar = locale === 'ar';
  const mode = await promptSetupChoice(prompt, { title: ar ? 'توجيه النوايا والقدرات' : 'Intent & capability routing',
    message: ar ? 'يختار Jev النوايا والمهارات والقدرات. تبقى أذونات التنفيذ كما هي. تسري التغييرات المحفوظة عند قرار التوجيه التالي.' : 'Jev-assisted mode selects intents, skills, and capabilities. Execution permissions stay the same. Saved changes apply at the next routing decision.',
    defaultValue: current.mode as string, choices: [
      { id: 'standard', value: 'standard', label: ar ? 'قياسي' : 'Standard' },
      { id: 'jev-assisted', value: 'jev-assisted', label: ar ? 'بمساعدة Jev' : 'Jev-assisted' },
      ...(check?[{id:'check',value:'check',label:ar?'فحص اتصال Jev المحفوظ':'Check saved Jev connection'}]:[]),
      { id: 'back', value: 'back', label: ar ? 'رجوع' : 'Back' },
    ] });
  if(mode==='check'&&check){
    const approved=await promptSetupChoice(prompt,{title:ar?'فحص الاتصال':'Connection check',message:ar?'يُرسل اختبار صغير إلى TypeSafe باستخدام الإعدادات المحفوظة. قد تُفرض رسوم.':'Send a small synthetic test to TypeSafe using saved settings. Charges may apply.',defaultValue:'back',choices:[{id:'check',value:'check',label:ar?'فحص الاتصال':'Check connection'},{id:'back',value:'back',label:ar?'رجوع':'Back'}]});
    if(approved==='check')await promptSetupChoice(prompt,{title:ar?'نتيجة الفحص':'Connection result',message:formatRoutingCheck(await check(),locale),defaultValue:'back',choices:[{id:'back',value:'back',label:ar?'رجوع':'Back'}]});
    return undefined;
  }
  if (mode === 'back') return undefined;
  if (mode === 'standard') return { values: { routingMode: mode } };
  const provider = await promptSetupChoice(prompt, { title: ar ? 'مزود التوجيه' : 'Routing provider',
    message: ar ? 'يتلقى TypeSafe سياق الطلب ذي الصلة وأوصاف القدرات.' : 'TypeSafe receives relevant request context and capability descriptions.',
    defaultValue: 'typesafe', choices: [{ id: 'typesafe', value: 'typesafe', label: 'TypeSafe' }, { id: 'back', value: 'back', label: ar ? 'رجوع' : 'Back' }] });
  if (provider === 'back') return undefined;
  const model = await promptSetupChoice(prompt, { title: ar ? 'نموذج التوجيه' : 'Routing model', message: ar ? 'اختر نموذج Jev.' : 'Choose a Jev model.', defaultValue: current.jev.id,
    choices: [...JEV_MODELS.map(m=>({id:m.id,value:m.id,label:m.label})), ...(!JEV_MODELS.some(m=>m.id===current.jev.id)?[{id:current.jev.id,value:current.jev.id,label:current.jev.id}]:[]), {id:'back',value:'back',label:ar?'رجوع':'Back'}] });
  if (model === 'back') return undefined;
  const credential = await promptForApiKeyInput({ prompt, providerId: 'typesafe', envVarName: current.jev.apiKeyEnv,
    question: ar ? 'أدخل مفتاح TypeSafe أو اتركه فارغًا للاحتفاظ بالمرجع الحالي: ' : 'Enter TypeSafe API key, or leave blank to keep the current reference: ' });
  return { values: { routingMode: mode, provider: 'typesafe', model, apiKeyEnv: current.jev.apiKeyEnv },
    ...(credential.kind==='entered'?{pendingCredentialWrites:[{envVarName:credential.envVarName,value:credential.value}]}:{}) };
}
