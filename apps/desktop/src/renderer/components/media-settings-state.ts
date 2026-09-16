import type {SettingChange,SettingValue,SettingsPage} from '@estacoda/control-protocol';
export type MediaKind='analysis'|'generation'|'transcription'|'speech';
export const mediaPrefix={analysis:'auxiliaryModels.vision',generation:'imageGen',transcription:'stt',speech:'tts'} as const;
/** A reset uses the runtime default, never the old effective value. */
export function mediaValue(page:SettingsPage,changes:SettingChange[],id:string):SettingValue{
 const pending=changes.find(c=>c.fieldId===id&&!c.selectors.length);
 if(pending)return pending.value===null?page.media?.defaults.find(c=>c.fieldId===id)?.value??null:pending.value;
 return page.media?.effective.find(c=>c.fieldId===id)?.value??page.values.find(c=>c.fieldId===id)?.value??null;
}
export function mediaProvider(kind:MediaKind,value:(id:string)=>SettingValue):string{return String(value(mediaPrefix[kind]+'.provider')??'');}
export function mediaModelField(kind:MediaKind,provider:string,localEngine?:SettingValue){return kind==='analysis'?'auxiliaryModels.vision.id':kind==='transcription'&&provider==='local'?(localEngine==='command'?'stt.local.model':'stt.local.fasterWhisper.model'):`${mediaPrefix[kind]}.${provider}.${provider==='elevenlabs'?'modelId':'model'}`;}
export function mediaVoiceField(provider:string){return `tts.${provider}.${['elevenlabs','minimax','mistral','xai'].includes(provider)?'voiceId':'voice'}`;}
export function mediaAdvancedFields(page:SettingsPage,kind:MediaKind,provider:string){
 const prefix=mediaPrefix[kind];
 return page.fields.filter(f=>f.id.startsWith(prefix+'.')&&(kind==='analysis'||f.path.length===2||f.path[1]===provider)&&f.kind!=='secret'&&!f.path.includes('*')&&!f.path.includes('#')&&!['provider','enabled','model','modelId','id','voice','voiceId','speed'].includes(f.path.at(-1)!)&&f.id!=='stt.xai.diarization'&&f.id!=='stt.xai.language');
}

/** Configuration schemas retain future providers; only implemented dispatchers are selectable. */
export function mediaProviderSupported(kind:MediaKind,provider:string){
 return kind==='transcription'?['local','openai','groq','xai'].includes(provider):kind==='speech'?['openai','edge','elevenlabs','minimax','gemini','xai'].includes(provider):true;
}
