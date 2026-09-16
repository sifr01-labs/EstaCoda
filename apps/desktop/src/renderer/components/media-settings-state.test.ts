import {it,expect} from 'vitest';
import type {SettingsPage} from '@estacoda/control-protocol';
import {mediaValue,mediaAdvancedFields,mediaModelField,mediaProviderSupported} from './media-settings-state.js';
it('distinguishes explicit reset from saved effective settings',()=>{
 const page:SettingsPage={fields:[],values:[],truncated:false,media:{effective:[{fieldId:'tts.openai.speed',selectors:[],value:1.7}],defaults:[{fieldId:'tts.openai.speed',selectors:[],value:1}]}};
 expect(mediaValue(page,[],'tts.openai.speed')).toBe(1.7);
 expect(mediaValue(page,[{fieldId:'tts.openai.speed',selectors:[],value:null}],'tts.openai.speed')).toBe(1);
 expect(mediaValue(page,[{fieldId:'tts.openai.speed',selectors:[],value:0.5}],'tts.openai.speed')).toBe(0.5);
});
it('only shows active provider options and one speaker-identification field',()=>{
 const page:SettingsPage={fields:['stt.xai.diarize','stt.xai.diarization','stt.xai.keyterms','stt.groq.model','tts.edge.speed'].map(id=>({id,path:id.split('.'),kind:'text',section:'voice'})),values:[],truncated:false};
 expect(mediaAdvancedFields(page,'transcription','xai').map(f=>f.id)).toEqual(['stt.xai.diarize','stt.xai.keyterms']);
 expect(mediaAdvancedFields(page,'transcription','local')).toEqual([]);
});

it('preserves command transcription and excludes deferred dispatchers',()=>{
 expect(mediaModelField('transcription','local','command')).toBe('stt.local.model');
 expect(mediaModelField('transcription','local','faster-whisper')).toBe('stt.local.fasterWhisper.model');
 expect(mediaProviderSupported('transcription','mistral')).toBe(false);
 expect(mediaProviderSupported('speech','neutts')).toBe(false);
 expect(mediaProviderSupported('speech','edge')).toBe(true);
});
