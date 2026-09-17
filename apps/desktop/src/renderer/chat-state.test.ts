import {it,expect} from 'vitest';
import {saveDrafts,restoreDrafts} from './chat-state.js';
it('restores queued text as an unsent draft without retaining permission authority or attachments',()=>{
 const stored=saveDrafts({'session:s':{id:'d',text:'Later thought',model:'m',note:'',attachments:[],securityMode:'open',queued:{id:'q',text:'Queued correction',attachments:[{id:'file',name:'n',size:1,type:'text/plain'}]}}});
 expect(stored['session:s']?.text).toBe('Queued correction\n\nLater thought');expect(stored['session:s']).not.toHaveProperty('securityMode');
 const restored=restoreDrafts(stored)['session:s'];expect(restored).not.toHaveProperty('queued');expect(restored?.attachments).toEqual([]);
});
it('retains creation intent without persisting attachment previews or permission authority',()=>{
 const saved=saveDrafts({'session:s':{id:'d',text:'A quiet landscape',intent:'image',attachments:[{id:'i',name:'ref.png',size:1,type:'image/png',thumbnail:'data:image/png;base64,AA'}],model:'m',note:''}});
 expect(restoreDrafts(saved)['session:s']).toMatchObject({intent:'image',text:'A quiet landscape',attachments:[]});expect(JSON.stringify(saved)).not.toContain('data:image');
});
