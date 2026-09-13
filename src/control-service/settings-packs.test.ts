import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import type {PackManifest} from '../contracts/pack.js';
import {SettingsActions} from './settings-actions.js';
import {ensureProfileSkeleton} from '../cli/profile-state.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
function makeManifest(overrides?: Partial<PackManifest>): PackManifest {
  return {
    id: "test-sp",
    name: "Test pack",
    version: "1.0.0",
    description: "A test pack",
    packType: "skill_pack",
    entrypoints: { skills: ["SKILL.md"] },
    permissions: {
      filesystem: { read: ["."] },
      shell: { allowedCommands: [], requiresApproval: true },
      network: { allowedHosts: [], requiresApproval: true },
      secrets: { requiredEnvironmentVariables: [], requiredCredentialFiles: [] },
      memory: { canRead: false, canWrite: false, requiresPromotionApproval: true },
      channels: { canSendMessages: false, canReceiveMessages: false, requiresApproval: true }
    },
    provenance: {
      origin: "local",
      trustLevel: "local_user"
    },
    sandbox: {
      defaultMode: "deny",
      filesystemMode: "read_only",
      shellMode: "deny",
      networkMode: "deny",
      secretsMode: "deny"
    },
    ...overrides
  };
}

it('binds pack review to content and installs a private snapshot into the selected profile',async()=>{
 const home=await mkdtemp(join(tmpdir(),'settings-packs-'));try{await ensureProfileSkeleton({homeDir:home,profileId:'selected',blank:true});const source=join(home,'source');await mkdir(source);await writeFile(join(source,'pack.json'),JSON.stringify(makeManifest()));await writeFile(join(source,'SKILL.md'),'first');const actions=new SettingsActions({homeDir:home,profileId:'selected'});const old=await actions.review({action:'pack.install',subject:source,value:''});await writeFile(join(source,'SKILL.md'),'second');await expect(actions.execute({reviewId:old.reviewId,operationId:'stale',confirmed:true})).rejects.toThrow();const review=await actions.review({action:'pack.install',subject:source,value:''});expect((await actions.execute({reviewId:review.reviewId,operationId:'install',confirmed:true})).state).toBe('completed');expect(await readFile(join(resolveProfileStateHome({homeDir:home,profileId:'selected'}).skillsPath,'packs','test-sp','SKILL.md'),'utf8')).toBe('second');}finally{await rm(home,{recursive:true,force:true});}
});
