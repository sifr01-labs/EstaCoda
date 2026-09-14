import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,readdirSync,statSync,writeFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {ChatPresentationStore} from './chat-presentation.js';
import {emptyChatPresentation,validChatPresentation} from '../shared/chat-presentation.js';
it('restores draft text, workspace references and chat organization in the selected profile',()=>{
 const dir=mkdtempSync('/tmp/ec-chats-');let profile='one';try{const store=new ChatPresentationStore(dir,()=>profile),value={selected:'draft:one',drafts:{'draft:one':{id:'submission:one',text:'Unsent draft',model:'model',target:{targetId:'project',targetGeneration:4}}},chats:{chat:{title:'Renamed',archived:true,unread:true}}};
 store.write('one',value);expect(new ChatPresentationStore(dir,()=>profile).read('one')).toEqual(value);expect(statSync(join(dir,readdirSync(dir)[0]!)).mode&0o777).toBe(0o600);
 profile='two';expect(store.read('two')).toEqual(emptyChatPresentation());expect(()=>store.write('one',value)).toThrow('profile');expect(()=>store.read('one')).toThrow('profile');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('rejects authority fields, oversized state, corrupt files and symlinks without overwriting saved data',()=>{
 const base=emptyChatPresentation();for(const value of [{...base,credentials:'secret'},{...base,drafts:{x:{id:'x',text:'a',model:'m',attachments:['expired']}}},{...base,drafts:{x:{id:'x',text:'a',model:'m',limitsReviewed:true}}},{...base,chats:{x:{title:'a'.repeat(161)}}}])expect(validChatPresentation(value)).toBe(false);
 const dir=mkdtempSync('/tmp/ec-chat-invalid-');try{const store=new ChatPresentationStore(dir,()=> 'one');store.write('one',base);const path=join(dir,readdirSync(dir)[0]!);writeFileSync(path,'broken');expect(()=>store.read('one')).toThrow('read');unlinkSync(path);symlinkSync('/etc/passwd',path);expect(()=>store.read('one')).toThrow('read');}finally{rmSync(dir,{recursive:true,force:true});}
});
