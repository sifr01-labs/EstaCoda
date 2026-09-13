import {it,expect} from 'vitest';
import {arabic,english} from './catalog.js';
import {isDisplayLanguage,translate,type MessageKey} from './index.js';
it('provides deterministic product copy with safe missing-key fallback',()=>{
 expect(translate('en','Reconnect')).toBe('Reconnect');expect(translate('ar','Reconnect')).toBe('إعادة الاتصال');
 expect(translate('ar','not a product message' as MessageKey)).toBe('Message unavailable.');
 expect(isDisplayLanguage('ar')).toBe(true);expect(isDisplayLanguage('arbitrary-profile')).toBe(false);
});
it('keeps every catalog key translated and interpolation tokens in parity',()=>{
 expect(Object.keys(english)).toEqual(Object.keys(arabic));
 for(const key of Object.keys(english) as MessageKey[]){expect(arabic[key].trim(),key).not.toBe('');expect(arabic[key].match(/\{\w+\}/g)??[],key).toEqual(english[key].match(/\{\w+\}/g)??[]);}
});

it('maps stable diagnostics without exposing arbitrary backend text',async()=>{
 const {displayStatus}=await import('./status.js');
 expect(displayStatus('ar','invalid_credential')).toBe('بيانات الاعتماد غير صالحة');
 expect(displayStatus('ar','private provider error /secret')).toBe(translate('ar','Unknown'));
 expect(displayStatus('ar','constructor')).toBe(translate('ar','Unknown'));
});

it('localizes every setup diagnostic instead of displaying protocol identifiers',async()=>{
 const {displayStatus}=await import('./status.js');
 for(const state of ['new-user','configured-ready','configured-degraded','partial-provider','missing-secret','broken-config','untrusted-workspace','state-not-writable'])for(const language of ['en','ar'] as const){expect(displayStatus(language,state)).not.toBe(state);expect(displayStatus(language,state)).not.toBe(translate(language,'Unknown'));}
});
