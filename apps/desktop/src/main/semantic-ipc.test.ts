import { expect,it,vi } from 'vitest';
vi.mock('electron',()=>({ipcMain:{}}));
import {validateSemanticPayload} from './semantic-ipc.js';
it('rejects renderer authority fields and invalid IDs',()=>{
 for(const payload of [{workId:'a',profileId:'other'},{workId:'../escape'},{workId:'a',generation:1},{workId:'a',cursor:'a'.repeat(2049)}])expect(()=>validateSemanticPayload('activity',payload)).toThrow();
 expect(()=>validateSemanticPayload('activity',{workId:'session:1'})).not.toThrow();
 expect(()=>validateSemanticPayload('snapshot',{method:'sessions.send'})).toThrow();
});

it('accepts only an ID for independent Work inspection',()=>{
 expect(()=>validateSemanticPayload('getWork',{workId:'session:old'})).not.toThrow();
 for(const payload of [{workId:'../escape'},{workId:'a',profileId:'other'},{workId:'a',cursor:'x'},{}])expect(()=>validateSemanticPayload('getWork',payload)).toThrow();
});
