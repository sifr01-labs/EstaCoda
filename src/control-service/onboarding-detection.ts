import {mkdir,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {collectSetupEntryState} from '../setup/setup-entry-state.js';
import {latestProfileApplyOperation,inspectProfileApply} from '../setup/review/profile-apply.js';
import {ControlProtocolError,type SetupDetection} from '../contracts/desktop-control/index.js';
type Identity={homeDir:string;profileId:string};
export async function detectOnboarding(input:Identity,workspaceRoot=input.homeDir):Promise<SetupDetection>{
 try {
  const id=await latestProfileApplyOperation(input);
  if(id&&(await inspectProfileApply(input,id)).state==='uncertain')return {state:'broken-config',mode:'repair',writable:false,launchReady:false,pendingApply:true};
  const state=await collectSetupEntryState({...input,workspaceRoot,readOnly:true});
  return {state:state.kind,mode:state.kind==='new-user'?'first-run':state.kind==='configured-ready'?'ready':'repair',writable:state.stateDirectoryWritable,launchReady:['configured-ready','configured-degraded'].includes(state.kind),pendingApply:false};
 }catch{return {state:'broken-config',mode:'repair',writable:false,launchReady:false,pendingApply:false};}
}
/** Directory bootstrap is not saved setup and never changes the global active-profile pointer. */
export async function bootstrapOnboarding(input:Identity):Promise<SetupDetection>{
 const before=await detectOnboarding(input);
 if(input.profileId!=='default'||before.mode!=='first-run'||!before.writable)throw new ControlProtocolError('-32003');
 const root=resolveProfileStateHome(input).profileRoot;
 for(const path of [dirname(dirname(root)),dirname(root),root]){
  try{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new ControlProtocolError('-32003');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(path,{mode:0o700});}
 }
 return detectOnboarding(input);
}
