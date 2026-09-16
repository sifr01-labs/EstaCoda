import openai from '../assets/providers/openai.svg';
import kimi from '../assets/providers/kimi.svg';
import deepseek from '../assets/providers/deepseek.svg';
import google from '../assets/providers/google.svg';
import openrouter from '../assets/providers/openrouter.svg';
import zai from '../assets/providers/zai.svg';
import type {CSSProperties} from 'react';
import type {ProviderProjection} from '@estacoda/control-protocol';
import {Badge,Icon} from './primitives.js';
import {useI18n} from '../i18n.js';
const marks:Record<string,string>={openai,codex:openai,kimi,deepseek,google,openrouter,zai,'z.ai':zai};
export function ProviderMark({id,label}:{id:string;label:string}){
 const src=marks[id];return <span className="ec-model-mark" aria-hidden="true">{src?<span className="ec-provider-symbol" style={{'--provider-mark':`url("${src}")`} as CSSProperties}/>:id==='local'||id.startsWith('custom-')||id==='__custom'?<Icon name="monitor"/>:label.slice(0,1).toUpperCase()}</span>;
}
export function ProviderStatus({provider}:{provider:ProviderProjection}){
 const {t,status}=useI18n();const attention=provider.state==='repair_required'||['credential_required','authorization_expired','unsupported'].includes(provider.health??'');
 return <Badge kind={attention?'warn':provider.health==='configured'?'good':''}>{attention?t('Needs attention'):status(provider.health??provider.state)}</Badge>;
}
