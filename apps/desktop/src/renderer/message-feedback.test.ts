import {expect,it} from 'vitest';
import {pendingMessageRecorded} from './message-feedback.js';
import type {ActivityProjection} from '@estacoda/control-protocol';
const pending={id:'d',text:'Continue',matchText:'Continue',startedAt:10000,knownIds:['old'],state:'sent' as const,attachments:[]};
const item={kind:'message',role:'user',id:'new',workId:'s',profileId:'p',sequence:1,timestamp:10001,text:'Continue'} as ActivityProjection;
it('requires a fresh user record and does not confuse an earlier identical message',()=>{
 expect(pendingMessageRecorded(pending,[item])).toBe(true);
 expect(pendingMessageRecorded(pending,[{...item,id:'old'}])).toBe(false);
 expect(pendingMessageRecorded(pending,[{...item,timestamp:1}])).toBe(false);
 expect(pendingMessageRecorded(pending,[{...item,kind:'message',role:'assistant',text:'Continue'}])).toBe(false);
});
it('reconciles bounded history, media-only prompts, and redacted echoes',()=>{
 const text='A'.repeat(20000);
 expect(pendingMessageRecorded({...pending,text,matchText:text},[{...item,kind:'message',role:'user',text:text.slice(0,16384)}])).toBe(true);
 expect(pendingMessageRecorded({...pending,text:'',matchText:'Analyze the attached media using the configured tools.'},[{...item,kind:'message',role:'user',text:'Analyze the attached media using the configured tools.'}])).toBe(true);
 expect(pendingMessageRecorded({...pending,text:'token=example please check',matchText:'token=example please check'},[{...item,kind:'message',role:'user',text:'token=[REDACTED] please check'}])).toBe(true);
 expect(pendingMessageRecorded(pending,[{...item,kind:'message',role:'user',text:'token=[REDACTED] unrelated'}])).toBe(false);
});
