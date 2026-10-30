import type {SettingChange,SettingValue,SettingsPage} from '@estacoda/control-protocol';
export function runtimeValue(page:SettingsPage,changes:SettingChange[],id:string):SettingValue {
 const pending=changes.find(c=>c.fieldId===id&&!c.selectors.length);
 return pending?pending.value===null?page.runtime?.defaults.find(c=>c.fieldId===id)?.value??null:pending.value:page.runtime?.effective.find(c=>c.fieldId===id)?.value??page.values.find(c=>c.fieldId===id)?.value??null;
}
/** A switch is a complete reviewed policy, never an implicit host fallback. */
export function executionSelectionChanges(page:SettingsPage,backend:'host'|'docker',imageId?:string):SettingChange[]{
 if(backend==='docker'&&(!imageId||!/^sha256:[a-f0-9]{64}$/.test(imageId)))throw new Error('Prepared image required');
 const policy:Record<string,SettingValue>={'execution.backend':backend,'execution.imageId':backend==='docker'?imageId!:null};
 for(const [key,value] of Object.entries({workspaceAccess:'read-write',commandNetwork:backend==='docker'?'disabled':'unrestricted',lifetime:backend==='docker'?'session':'host'})){
  policy[`execution.${key}.value`]=value;policy[`execution.${key}.requirement`]='mandatory';
 }
 for(const key of ['credentialCapabilities','limits']){
  policy[`execution.${key}.requirement`]=backend==='docker'?'mandatory':null;
 }
 policy['execution.credentialCapabilities.value']=backend==='docker'?[]:null;
 for(const [key,value] of Object.entries({cpu:1,memoryBytes:512*1024*1024,pids:128,outputBytes:4*1024*1024,timeoutMs:120000}))policy['execution.limits.value.'+key]=backend==='docker'?value:null;
 return page.fields.filter(f=>f.id.startsWith('execution.')).map(f=>({fieldId:f.id,selectors:[],value:policy[f.id]??null}));
}
export const runtimeSettingLabels={
 'runLimits.interactive.maxDurationMinutes':'Interactive run duration (minutes)', 'runLimits.interactive.maxIterations':'Interactive model steps', 'runLimits.interactive.maxToolCalls':'Interactive tool calls',
 'runLimits.unattended.maxDurationMinutes':'Unattended run duration (minutes)', 'runLimits.unattended.maxIterations':'Unattended model steps', 'runLimits.unattended.maxToolCalls':'Unattended tool calls',
 'routing.mode':'Routing mode','routing.jev.provider':'Routing provider','routing.jev.id':'Routing model','routing.jev.apiKeyEnv':'API key','routing.jev.timeoutMs':'Routing timeout (milliseconds)',
 'execution.backend':'Execution environment','execution.imageId':'Prepared image',
 'execution.workspaceAccess.value':'Project files','execution.workspaceAccess.requirement':'File access enforcement',
 'execution.commandNetwork.value':'Command network','execution.commandNetwork.requirement':'Network enforcement',
 'execution.credentialCapabilities.value':'Credential forwarding','execution.credentialCapabilities.requirement':'Credential enforcement',
 'execution.lifetime.value':'Environment lifetime','execution.lifetime.requirement':'Lifetime enforcement',
 'execution.limits.value.cpu':'CPU cores','execution.limits.value.memoryBytes':'Memory (MB)','execution.limits.value.pids':'Maximum processes','execution.limits.value.outputBytes':'Captured output (MB)','execution.limits.value.timeoutMs':'Command timeout (seconds)','execution.limits.requirement':'Resource enforcement',
 'ui.language':'Command-line language','ui.flavor':'Status style','ui.activityLabels':'Activity language','ui.showResponseProgress':'Response progress','profile.mode':'Working style','profile.responseLanguage':'Response language'
} as const;
export function runtimeDisplay(change:SettingChange):string|number|boolean|string[]|null {
 if(change.fieldId.startsWith('runLimits.interactive.')&&change.value===0)return 'unlimited';
 if(typeof change.value==='number')return change.fieldId.endsWith('Bytes')?change.value/1024/1024:change.fieldId.endsWith('timeoutMs')&&!change.fieldId.startsWith('routing.')?change.value/1000:change.value;
 return change.value;
}

export const runtimeChoiceLabels={unlimited:'No limit','jev-assisted':'Jev-assisted',typesafe:'TypeSafe',host:'This computer',docker:'Isolated environment',mandatory:'Required',advisory:'Preferred','read-only':'Read only','read-write':'Read and write',disabled:'Blocked',unrestricted:'Allowed',session:'This session',en:'English',ar:'Arabic','match-user':'Match my message',focused:'Focused',operator:'Operator',builder:'Builder',research:'Research',standard:'Standard','arabic-light':'Arabic light','kemet-full':'Kemet full'} as const;
