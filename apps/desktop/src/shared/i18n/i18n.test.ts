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
