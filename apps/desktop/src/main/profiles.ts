import { readdirSync } from 'node:fs';
import { resolveGlobalStateHome, readActiveProfile } from '../../../../src/config/profile-home.js';
import { validateProfileId } from './service-process.js';
export class Profiles {
  constructor(readonly home: string) {}
  list(): {id:string;label:string}[] {
    const ids=new Set(['default']);
    try {for(const entry of readdirSync(resolveGlobalStateHome({homeDir:this.home}).profilesRoot,{withFileTypes:true}).slice(0,1024)) {
      if(!entry.isDirectory())continue;try{validateProfileId(entry.name);ids.add(entry.name);}catch{}
    }}catch{}
    return [...ids].sort().map(id=>({id,label:id}));
  }
  initial():string {try{const id=readActiveProfile({homeDir:this.home}).profileId;return this.list().some(profile=>profile.id===id)?id:'default';}catch{return'default';}}
  assertSelectable(id:unknown):asserts id is string {
    validateProfileId(id);if(!this.list().some(profile=>profile.id===id))throw new Error('Profile unavailable.');
  }
}
