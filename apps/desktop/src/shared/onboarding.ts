import type {SettingChange} from '@estacoda/control-protocol';
export type OnboardingPreferences={language:'en'|'ar';style:'standard'|'arabic-light'|'kemet-full';safety:'strict'|'adaptive'|'open';evolution:'none'|'suggest'|'proactive'|'autonomous'};
/** Convert product choices to the same reviewed fields used by Settings and the CLI. */
export function onboardingPreferenceChanges(value:OnboardingPreferences):SettingChange[]{
 return [['ui.language',value.language],['ui.flavor',value.style],['security.approvalMode',value.safety],['skills.autonomy',value.evolution]].map(([fieldId,value])=>({fieldId:fieldId!,selectors:[],value:value!}));
}
