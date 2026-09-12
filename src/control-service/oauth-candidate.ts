import {validateOAuthStore} from '../providers/oauth/oauth-store.js';
/** Validate staged OAuth again at each boundary, including Apply without a live verification. */
export function oauthCandidate(value:string,providerId:string){
 const parsed=validateOAuthStore({version:1,providers:{[providerId]:JSON.parse(value)}}),record=parsed.store.providers[providerId];
 if(providerId!=='codex'||parsed.diagnostics.length||!record||record.authMethod!=='oauth_device_pkce'||/[\r\n\0]/.test(record.accessToken)||record.expiresAt&&(!Number.isFinite(Date.parse(record.expiresAt))||Date.parse(record.expiresAt)<=Date.now()))throw new Error('Invalid staged authorization');
 return record;
}
