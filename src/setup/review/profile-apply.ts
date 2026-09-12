import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, open, rename, rm, lstat} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {resolveProfileStateHome} from '../../config/profile-home.js';
import {withProfileWriteLock, assertProfileApplySettled} from '../../config/profile-write-lock.js';
import {applyReviewedSetupPlanOperations, applyReviewedSetupDeferredSecrets, applyReviewedSetupDeferredOAuth} from './apply-executor.js';
import type {SetupApplyPlan, SetupDeferredSecretWrite, SetupDeferredOAuthWrite} from '../setup-apply-plan.js';

const names=['.env','auth.json','config.json'] as const;
type Files=Record<typeof names[number],string|null>;
type Identity={homeDir:string;profileId:string};
export type ProfileApplySnapshot={files:Files};
export type ProfileApplyReceipt={operationId:string;state:'applied'|'uncertain'|'unknown'};
const journalName='.profile-apply.json';

async function readBounded(path:string,limit=1_048_576):Promise<string|null> {
  let file;
  try {file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  try {
    if(!(await file.stat()).isFile())throw new Error('Invalid profile file');
    const data=Buffer.alloc(limit+1);let size=0;
    while(size<data.length){const part=await file.read(data,size,data.length-size,size);if(!part.bytesRead)break;size+=part.bytesRead;}
    if(size>limit)throw new Error('Profile file exceeds limit');
    return new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,size));
  } finally {await file.close();}
}
async function syncDirectory(root:string){const dir=await open(root,'r');try{await dir.sync();}finally{await dir.close();}}
async function atomicWrite(path:string,value:string) {
  const temp=path+'.'+randomUUID()+'.tmp';const file=await open(temp,'wx',0o600);
  try {await file.writeFile(value,'utf8');await file.sync();} finally {await file.close();}
  try {await rename(temp,path);await syncDirectory(dirname(path));} finally {await rm(temp,{force:true});}
}
export async function captureProfileApplySnapshot(input:Identity):Promise<ProfileApplySnapshot> {
  const root=resolveProfileStateHome(input).profileRoot;
  await assertProfileApplySettled(root);
  try {if((await lstat(root)).isSymbolicLink())throw new Error('Invalid profile directory');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const files={} as Files;for(const name of names)files[name]=await readBounded(join(root,name));
  await assertProfileApplySettled(root);return {files};
}
async function finish(root:string,operationId:string,files:Files,afterWrite?:(name:string)=>Promise<void>) {
  for(const name of names){if(files[name]===null)await rm(join(root,name),{force:true});else await atomicWrite(join(root,name),files[name]);await afterWrite?.(name);}
  await atomicWrite(join(root,'.profile-apply-receipt.json'),JSON.stringify({operationId,state:'applied'}));
  await rm(join(root,journalName));await syncDirectory(root);
}
/** Resume only an already-authorized commit. A failed recovery leaves the activation blocker in place. */
export async function recoverProfileApply(input:Identity):Promise<ProfileApplyReceipt|null> {
  const root=resolveProfileStateHome(input).profileRoot;
  const pending=await readBounded(join(root,journalName),4_194_304);if(pending===null)return null;
  return withProfileWriteLock(root,async()=>{
    const raw=await readBounded(join(root,journalName),4_194_304);if(raw===null)return null;
    const journal=JSON.parse(raw);
    if(!/^[a-f0-9-]{36}$/.test(journal.operationId)||!journal.files||Object.keys(journal.files).sort().join()!==[...names].sort().join()||names.some(name=>journal.files[name]!==null&&typeof journal.files[name]!=='string'))throw new Error('Profile recovery needs repair');
    await finish(root,journal.operationId,journal.files);return {operationId:journal.operationId,state:'applied'};
  });
}
export async function inspectProfileApply(input:Identity,operationId:string):Promise<ProfileApplyReceipt> {
  const root=resolveProfileStateHome(input).profileRoot;
  const pending=await readBounded(join(root,journalName),4_194_304);
  if(pending!==null){const journal=JSON.parse(pending);if(journal.operationId===operationId)return {operationId,state:'uncertain'};}
  const raw=await readBounded(join(root,'.profile-apply-receipt.json'));
  if(raw!==null){const receipt=JSON.parse(raw);if(receipt.operationId===operationId&&receipt.state==='applied')return {operationId,state:'applied'};}
  return {operationId,state:'unknown'};
}
/** Stage through the existing reviewed executor, then durably authorize a recoverable multi-file commit. */
export async function applyProfilePlan(input:Identity & {operationId:string;snapshot:ProfileApplySnapshot;plan:SetupApplyPlan;
  secrets?:readonly SetupDeferredSecretWrite[];oauth?:readonly SetupDeferredOAuthWrite[];signal:AbortSignal;
  afterWrite?:(name:string)=>Promise<void>}):Promise<ProfileApplyReceipt> {
  if(!/^[a-f0-9-]{36}$/.test(input.operationId))throw new Error('Invalid apply operation');
  const root=resolveProfileStateHome(input).profileRoot;
  input.signal.throwIfAborted();
  return withProfileWriteLock(root,async()=>{
    const previous=await inspectProfileApply(input,input.operationId);if(previous.state!=='unknown')return previous;
    const current=await captureProfileApplySnapshot(input);
    if(names.some(name=>current.files[name]!==input.snapshot.files[name]))throw new Error('Profile changed; review again');
    input.signal.throwIfAborted();
    const stage=join(root,'.profile-stage-'+randomUUID());await mkdir(stage,{mode:0o700});
    try {
      const staged=resolveProfileStateHome({homeDir:stage,profileId:input.profileId});await mkdir(staged.profileRoot,{recursive:true,mode:0o700});
      for(const name of names)if(current.files[name]!==null)await atomicWrite(join(staged.profileRoot,name),current.files[name]);
      const options={homeDir:stage,profileId:input.profileId,workspaceRoot:stage,isolateCredentialEnvironment:true,persistRouteTransport:true};
      if(input.plan.operations.some(op=>!['config-patch','credential-reference'].includes(op.kind) || (op.kind==='config-patch' && !['setupDrafts.credentialReference.summary','setupDrafts.providerModelRoute.summary','setupDrafts.providerModelEndpointRoute.summary','setupDrafts.fallbackModelRoutes.order.summary','setupDrafts.fallbackModelRoute.add.summary','setupDrafts.fallbackModelRoute.replace.summary','setupDrafts.auxiliaryMode.summary','setupDrafts.auxiliaryModelRoute.summary'].includes(op.review.summaryKey))))throw new Error('Unsupported profile apply operation');
      const applied=await applyReviewedSetupPlanOperations(input.plan,options);
      if(!applied.ok)throw new Error('Reviewed configuration apply failed');
      if(input.secrets?.length && !(await applyReviewedSetupDeferredSecrets(input.plan,input.secrets,options)).ok)throw new Error('Reviewed credential apply failed');
      if(input.oauth?.length && !(await applyReviewedSetupDeferredOAuth(input.plan,input.oauth,options)).ok)throw new Error('Reviewed authorization apply failed');
      const next=await captureProfileApplySnapshot({homeDir:stage,profileId:input.profileId});
      input.signal.throwIfAborted();
      // Once this record is durable, cancellation cannot claim that nothing was saved.
      try {await atomicWrite(join(root,journalName),JSON.stringify({operationId:input.operationId,files:next.files}));}
      catch(error){if(await readBounded(join(root,journalName),4_194_304)!==null)return {operationId:input.operationId,state:'uncertain'};throw error;}
      try {await finish(root,input.operationId,next.files,input.afterWrite);return {operationId:input.operationId,state:'applied'};}
      catch {return {operationId:input.operationId,state:'uncertain'};}
    } finally {await rm(stage,{recursive:true,force:true}).catch(()=>undefined);}
  });
}
